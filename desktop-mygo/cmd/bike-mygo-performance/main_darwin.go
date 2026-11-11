//go:build darwin

// This development-only executable is built separately from the shipped app.
package main

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/frontend"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/mcp"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/platform"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

//go:embed performance.js
var performanceJS string

//go:embed peaks.js
var peaksJS string

//go:embed process_metrics.py
var processMetrics string

type Performance struct {
	directory     string
	profile       string
	desktop       *platform.Desktop
	peak          bool
	controllerPID int
	window        *mygo.Window
	mutex         sync.Mutex
	sampleMutex   sync.Mutex
	transferMutex sync.Mutex
	chunks        []map[string]any
	chunkSamples  []map[string]any
	traceErrors   []string
	started       time.Time
}

// Observe the existing bridge in the diagnostic executable. The MyGO runtime
// object is frozen, so assigning window.mygo.call cannot intercept calls.
type peakDesktop struct{ performance *Performance }

func (bridge *peakDesktop) Invoke(ctx context.Context, method, payload string) (map[string]any, error) {
	p := bridge.performance
	started := time.Now()
	result, err := p.desktop.Invoke(ctx, method, payload)
	if method == "writeAttachmentChunk" {
		var request struct {
			Offset int64  `json:"offset"`
			Data   string `json:"data"`
		}
		if decodeError := json.Unmarshal([]byte(payload), &request); decodeError != nil {
			p.transferMutex.Lock()
			p.traceErrors = append(p.traceErrors, decodeError.Error())
			p.transferMutex.Unlock()
			return result, err
		}
		padding := len(request.Data) - len(strings.TrimRight(request.Data, "="))
		chunk := map[string]any{
			"offset": request.Offset, "decodedBytes": base64.StdEncoding.DecodedLen(len(request.Data)) - padding,
			"base64Characters": len(request.Data), "payloadJSONBytes": len(payload),
			"elapsedMs": float64(time.Since(started).Microseconds()) / 1000,
			"ok":        err == nil && result["ok"] == true,
		}
		p.transferMutex.Lock()
		p.chunks = append(p.chunks, chunk)
		count := len(p.chunks)
		p.transferMutex.Unlock()
		if count == 1 || count == 64 || count == 128 {
			p.transferSample(fmt.Sprintf("attachment-chunk-%d", count))
		}
	} else if method == "finishAttachmentUpload" {
		p.transferSample("attachment-native-finish-returned")
	}
	return result, err
}

func (bridge *peakDesktop) Reply(ctx context.Context, id, result, message string) error {
	return bridge.performance.desktop.Reply(ctx, id, result, message)
}

func (p *Performance) transferSample(label string) {
	sample, err := p.Sample(label)
	p.transferMutex.Lock()
	defer p.transferMutex.Unlock()
	if err != nil {
		p.traceErrors = append(p.traceErrors, err.Error())
	} else {
		p.chunkSamples = append(p.chunkSamples, sample)
	}
}

func (p *Performance) AttachmentTransfer(reset bool) map[string]any {
	p.transferMutex.Lock()
	defer p.transferMutex.Unlock()
	if reset {
		p.chunks, p.chunkSamples, p.traceErrors = nil, nil, nil
	}
	return map[string]any{
		"chunks": append([]map[string]any{}, p.chunks...), "samples": append([]map[string]any{}, p.chunkSamples...),
		"errors":   append([]string{}, p.traceErrors...),
		"observer": "diagnostic Go Desktop forwarding wrapper, production Invoke/Reply receive the original context and payload",
	}
}

func (p *Performance) Capture(ctx context.Context, name string) error {
	if name != "proposal-pending" {
		return fmt.Errorf("invalid performance capture")
	}
	image, err := mygo.CallerWindow(ctx).CapturePage()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(p.directory, name+".png"), image, 0600)
}

// LiveTool uses the same production socket client as the native runtime probe.
// JSON text avoids making the test transport an additional object codec.
func (p *Performance) LiveTool(ctx context.Context, operation, arguments string) (string, error) {
	store, err := mcp.OpenLive(ctx, filepath.Join(p.profile, "live-mcp.json"))
	if err != nil {
		return "", err
	}
	defer store.Close()
	parsed, err := contracts.ParseJSON([]byte(arguments))
	if err != nil {
		return "", err
	}
	args, ok := parsed.(*contracts.Object)
	if !ok {
		return "", fmt.Errorf("performance arguments must be an object")
	}
	var result *contracts.Object
	switch operation {
	case "snapshot":
		snapshot, loadError := store.Load(ctx)
		if loadError != nil {
			return "", loadError
		}
		result = contracts.NewObject()
		result.Set("workspace", snapshot.Ordered)
		result.Set("revision", snapshot.Revision)
	case "status":
		result, err = store.Status(ctx, args.String("requestId"))
	case "append_children":
		result, err = store.Mutate(ctx, operation, args)
	default:
		return "", fmt.Errorf("unsupported performance operation")
	}
	if err != nil {
		return "", err
	}
	raw, err := contracts.Stringify(result, false, false)
	return string(raw), err
}

// Inspect the installed original through the real library, with bounded reads.
// The byte pattern is identical to peaks.js, including every original byte.
func (p *Performance) AttachmentEvidence(assetID, expectedSHA256 string) (map[string]any, error) {
	file, metadata, err := p.desktop.Library.Open(assetID, nil)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	digest := sha256.New()
	buffer := make([]byte, 1024*1024)
	var count int64
	for {
		n, readError := file.Read(buffer)
		for i, value := range buffer[:n] {
			offset := count + int64(i)
			if value != byte(offset*31+(offset>>8)) {
				return nil, fmt.Errorf("original byte mismatch at %d", offset)
			}
		}
		digest.Write(buffer[:n])
		count += int64(n)
		if readError == io.EOF {
			break
		}
		if readError != nil {
			return nil, readError
		}
	}
	actual := hex.EncodeToString(digest.Sum(nil))
	if actual != expectedSHA256 || assetID != "sha256:"+actual || count != metadata.ByteLength {
		return nil, fmt.Errorf("installed original hash or metadata mismatch")
	}
	temporary := []string{}
	entries, err := os.ReadDir(p.desktop.Library.Directory)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if (strings.HasPrefix(entry.Name(), ".upload-") || strings.HasPrefix(entry.Name(), ".import-")) && strings.HasSuffix(entry.Name(), ".tmp") {
			temporary = append(temporary, entry.Name())
		}
	}
	return map[string]any{"sha256": actual, "byteLength": count, "originalBytesVerified": true, "metadata": metadata, "temporaryFiles": temporary, "implementation": "production Go Attachments.Open plus streamed SHA256 and byte comparison"}, nil
}

func findWebView(view objc.ID) objc.ID {
	if objc.Send[bool](view, objc.RegisterName("isKindOfClass:"), objc.GetClass("WKWebView")) {
		return view
	}
	children := view.Send(objc.RegisterName("subviews"))
	for i := range objc.Send[int](children, objc.RegisterName("count")) {
		if found := findWebView(children.Send(objc.RegisterName("objectAtIndex:"), i)); found != 0 {
			return found
		}
	}
	return 0
}

func (p *Performance) networkProcessID() int {
	var pid int
	mygo.RunOnMain(func() {
		view := findWebView(objc.ID(p.window.NativeHandle()).Send(objc.RegisterName("contentView")))
		if view == 0 {
			return
		}
		store := view.Send(objc.RegisterName("configuration")).Send(objc.RegisterName("websiteDataStore"))
		selector := objc.RegisterName("_networkProcessIdentifier")
		if objc.Send[bool](store, objc.RegisterName("respondsToSelector:"), selector) {
			pid = int(objc.Send[int32](store, selector))
		}
	})
	return pid
}

func (p *Performance) Sample(label string) (map[string]any, error) {
	if p.peak {
		// Keep the independent resident and renderer stage collectors from
		// attributing each other's Python process to the measured application.
		p.sampleMutex.Lock()
		defer p.sampleMutex.Unlock()
	}
	processToSampleMs := float64(time.Since(p.started).Microseconds()) / 1000
	pids, _ := json.Marshal(map[string][]int{
		"webContent": {p.window.Page().ProcessID()},
		"gpu":        {p.window.Page().GPUProcessID()},
		"network":    {p.networkProcessID()},
	})
	arguments := []string{"-c", processMetrics, strconv.Itoa(os.Getpid()), string(pids)}
	if p.peak {
		arguments = append(arguments, strconv.Itoa(p.controllerPID))
	}
	bytes, err := exec.Command("/usr/bin/python3", arguments...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("process accounting: %w: %s", err, bytes)
	}
	var sample map[string]any
	if err := json.Unmarshal(bytes, &sample); err != nil {
		return nil, err
	}
	sample["label"] = label
	sample["processToSampleMs"] = processToSampleMs
	sample["knownPIDs"] = json.RawMessage(pids)
	sample["applicationActive"] = mygo.App.IsActive()
	sample["windowFocused"] = p.window.IsFocused()
	if p.peak {
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		sample["goMemory"] = map[string]any{"heapAllocBytes": memory.HeapAlloc, "heapInuseBytes": memory.HeapInuse, "sysBytes": memory.Sys, "numGC": memory.NumGC}
	}
	return sample, nil
}

func (p *Performance) Checkpoint(value map[string]any) error {
	p.mutex.Lock()
	defer p.mutex.Unlock()
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(p.directory, "checkpoints.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(data, '\n'))
	return err
}

func (p *Performance) residentSample() {
	sample, err := p.Sample("resident-interval")
	if err != nil {
		if p.peak {
			fmt.Fprintln(os.Stderr, "resident sampling error:", err)
			p.Checkpoint(map[string]any{"residentSamplingError": err.Error()})
		}
		return
	}
	bytes, err := json.Marshal(sample)
	if err != nil {
		return
	}
	p.mutex.Lock()
	defer p.mutex.Unlock()
	file, err := os.OpenFile(filepath.Join(p.directory, "resident-samples.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err == nil {
		defer file.Close()
		file.Write(append(bytes, '\n'))
	}
}

type host struct{ info product.Info }

func (h host) Info() product.Info { return h.info }

func main() {
	started := time.Now()
	configuration := flag.String("config", "", "explicit JSON test configuration")
	directory := flag.String("output", "", "isolated evidence and service directory")
	profile := flag.String("profile", "", "optional shared isolated service profile for restart verification")
	timeout := flag.Duration("timeout", 8*time.Minute, "hard scenario deadline")
	flag.Parse()
	if *configuration == "" || *directory == "" {
		panic("--config and --output required")
	}
	var config map[string]any
	if err := json.Unmarshal([]byte(*configuration), &config); err != nil {
		panic(err)
	}
	if err := os.MkdirAll(*directory, 0700); err != nil {
		panic(err)
	}
	if *profile == "" {
		*profile = filepath.Join(*directory, "profile")
	}
	files, err := frontend.Files()
	if err != nil {
		panic(err)
	}
	info, err := product.Current()
	if err != nil {
		panic(err)
	}
	info.Name, info.Identifier = "Bike MyGO Performance", "com.bike.mygo.performance"
	if config["scenario"] == "proposal-peak" || config["scenario"] == "attachment-peak" {
		info.Identifier += ".peaks"
	}
	mygo.App.SetName(info.Name)
	mygo.App.SetVersion(info.Version)
	mygo.App.SetPath(mygo.PathUserData, *profile)
	mygo.SetFrontend(files)
	desktop := platform.NewDesktop(info, *profile, filepath.Join(*directory, "cloud"))
	mygo.BindAs("BikeHost", host{info: info})
	peak := config["scenario"] == "proposal-peak" || config["scenario"] == "attachment-peak"
	controllerPID, _ := config["controllerPID"].(float64)
	probe := &Performance{directory: *directory, profile: *profile, desktop: desktop, started: started, peak: peak, controllerPID: int(controllerPID)}
	if peak {
		mygo.BindAs("Desktop", &peakDesktop{performance: probe})
	} else {
		platform.BindDesktop(desktop)
	}
	mygo.BindAs("Performance", probe)
	mygo.App.OnQuit(desktop.Close)
	mygo.App.WhenReady(func() {
		if config["action"] == "seed" || config["action"] == "cleanup" {
			if err := mygo.DefaultSession().ClearData(mygo.SiteDataAll); err != nil {
				fmt.Fprintln(os.Stderr, err)
				mygo.App.Exit(2)
				return
			}
		}
		if config["action"] == "cleanup" {
			bytes, _ := json.Marshal(map[string]any{"result": map[string]any{"cleaned": true}, "production": !mygo.IsDev()})
			if err := os.WriteFile(filepath.Join(*directory, "result.json"), append(bytes, '\n'), 0600); err != nil {
				fmt.Fprintln(os.Stderr, err)
				mygo.App.Exit(2)
				return
			}
			mygo.App.Quit()
			return
		}
		window := mygo.NewWindow(mygo.WindowOptions{Title: info.Name, Width: 1366, Height: 960, URL: "/", Page: mygo.PageOptions{PreloadScript: `window.__performanceErrors=[];window.addEventListener('error',e=>window.__performanceErrors.push({message:e.message,stack:e.error?.stack}));window.addEventListener('unhandledrejection',e=>window.__performanceErrors.push({rejection:String(e.reason),stack:e.reason?.stack}));`}})
		probe.window = window
		desktop.SetWindow(window)
		mygo.App.Focus()
		window.Focus()
		if config["action"] == "measure" {
			stop := make(chan struct{})
			mygo.App.OnQuit(func() { close(stop) })
			go func() {
				interval := 2 * time.Second
				if peak {
					interval = 250 * time.Millisecond
				}
				ticker := time.NewTicker(interval)
				defer ticker.Stop()
				for {
					select {
					case <-stop:
						return
					case <-ticker.C:
						probe.residentSample()
					}
				}
			}()
		}
		var once sync.Once
		window.Page().OnDidFinishLoad(func() {
			once.Do(func() {
				if err := os.WriteFile(filepath.Join(*directory, "window-ready.json"), []byte("{}\n"), 0600); err != nil {
					fmt.Fprintln(os.Stderr, err)
					mygo.App.Exit(2)
					return
				}
				go func() {
					code := "(async()=>{const config=" + *configuration + ";const runPeak=async(config,helpers)=>{" + peaksJS + "};" + performanceJS + "})()"
					result, evalError := window.Page().Eval(code)
					payload := map[string]any{"result": result, "production": !mygo.IsDev(), "identity": info, "processElapsedMs": float64(time.Since(started).Microseconds()) / 1000}
					if evalError != nil {
						payload["error"] = evalError.Error()
					}
					if config["action"] == "cleanup" {
						if err := mygo.DefaultSession().ClearData(mygo.SiteDataAll); err != nil {
							payload["cleanupError"] = err.Error()
						}
					}
					bytes, err := json.MarshalIndent(payload, "", "  ")
					if err == nil {
						err = os.WriteFile(filepath.Join(*directory, "result.json"), append(bytes, '\n'), 0600)
					}
					if err != nil {
						fmt.Fprintln(os.Stderr, err)
						mygo.App.Exit(2)
						return
					}
					mygo.App.Quit()
				}()
			})
		})
	})
	go func() {
		time.Sleep(*timeout)
		fmt.Fprintln(os.Stderr, "performance scenario hard deadline")
		mygo.App.Exit(3)
	}()
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
