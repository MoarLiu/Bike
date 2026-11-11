//go:build darwin

// This separate test executable never ships in the application bundle.
package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing/fstest"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/frontend"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/mcp"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/platform"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
	"github.com/egoist/mygo"
)

//go:embed probe.js
var probeJS string

//go:embed preload.js
var preloadJS string

type Probe struct {
	directory  string
	desktop    *platform.Desktop
	fixtureURL string
}

func (probe Probe) FixtureURL() string { return probe.fixtureURL }
func (probe Probe) Production() bool   { return !mygo.IsDev() }
func (probe Probe) Progress() {
	probe.desktop.Emit("attachmentSyncProgress", map[string]any{"assetId": "fixture", "phase": "test", "transferred": 1, "byteLength": 1})
}
func (probe Probe) CloseBarrier(ctx context.Context) bool {
	ready := probe.desktop.PrepareClose(ctx)
	probe.desktop.Emit("updateState", map[string]any{"status": "idle", "currentVersion": "2.0.0"})
	return ready
}

// JSON text keeps the probe's own strict IPC transport from masking changes in
// the product's Live event and reply paths.
func (probe Probe) LiveTool(ctx context.Context, operation, arguments string) (string, error) {
	store, err := mcp.OpenLive(ctx, filepath.Join(probe.directory, "profile", "live-mcp.json"))
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
		return "", fmt.Errorf("probe arguments must be an object")
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
	case "update_node":
		result, err = store.Mutate(ctx, operation, args)
	default:
		return "", fmt.Errorf("unsupported probe operation")
	}
	if err != nil {
		return "", err
	}
	raw, err := contracts.Stringify(result, false, false)
	return string(raw), err
}

func (probe Probe) Echo(value map[string]any) map[string]any { return value }

func (probe Probe) Capture(ctx context.Context, name string) error {
	if name != "outline" && name != "mindmap" && name != "presentation" && name != "markdown" {
		return fmt.Errorf("invalid capture name")
	}
	image, err := mygo.CallerWindow(ctx).CapturePage()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(probe.directory, name+".png"), image, 0600)
}

func (probe Probe) Downloads() ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(probe.directory, "downloads"))
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	return names, nil
}

func main() {
	version := flag.Bool("version", false, "print test build identity")
	mode := flag.String("mode", "", "seed, ui, verify, isolate or cleanup")
	directory := flag.String("output", "", "test evidence directory")
	flag.Parse()
	info, err := product.Current()
	if err != nil {
		panic(err)
	}
	if *version {
		json.NewEncoder(os.Stdout).Encode(info)
		return
	}
	if *directory == "" || (*mode != "seed" && *mode != "ui" && *mode != "verify" && *mode != "isolate" && *mode != "isolate-control" && *mode != "cleanup") {
		panic("explicit test mode and output required")
	}
	if err := os.MkdirAll(filepath.Join(*directory, "downloads"), 0700); err != nil {
		panic(err)
	}
	mygo.App.SetName("Bike MyGO Runtime Test")
	mygo.App.SetVersion(info.Version)
	mygo.App.SetPath(mygo.PathUserData, filepath.Join(*directory, "profile"))
	var files fs.FS
	files, err = frontend.Files()
	if err != nil {
		panic(err)
	}
	if *mode == "isolate" || *mode == "isolate-control" {
		files = fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte(`<!doctype html><meta charset="utf-8"><div class="shell">isolated MyGO startup</div>`)}}
	}
	mygo.SetFrontend(files)
	desktop := platform.NewDesktop(info, filepath.Join(*directory, "profile"), filepath.Join(*directory, "cloud"))
	fixture := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		io.Copy(io.Discard, request.Body)
		if request.URL.Path == "/slow/responses" {
			<-request.Context().Done()
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		if request.Header.Get("Authorization") != "Bearer fixture-key" {
			writer.WriteHeader(401)
			return
		}
		if request.URL.Path == "/v1/chat/completions" {
			writer.Write([]byte(`{"choices":[{"message":{"content":"fixture 中文🙂"}}]}`))
			return
		}
		if request.URL.Path == "/api/v2/status" {
			writer.Write([]byte(`{"fixture":true}`))
			return
		}
		writer.WriteHeader(404)
	}))
	mygo.Bind(Probe{directory: *directory, desktop: desktop, fixtureURL: fixture.URL})
	mygo.App.OnQuit(func() { fixture.CloseClientConnections(); fixture.Close() })
	platform.BindDesktop(desktop)
	mygo.App.OnQuit(desktop.Close)
	mygo.App.WhenReady(func() {
		window := mygo.NewWindow(mygo.WindowOptions{Title: "Bike MyGO Runtime Test", Width: 1366, Height: 960, URL: "/", Page: mygo.PageOptions{PreloadScript: preloadJS}})
		desktop.SetWindow(window)
		window.Page().OnWillDownload(func(event *mygo.DownloadEvent) {
			event.Path = filepath.Join(*directory, "downloads", filepath.Base(event.SuggestedName))
		})
		var once sync.Once
		window.Page().OnDidFinishLoad(func() {
			once.Do(func() {
				go func() {
					encodedMode, _ := json.Marshal(*mode)
					code := "const mode=" + string(encodedMode) + ";" + probeJS
					// MyGO Eval first compiles its input as an expression. A statement
					// body causes WebKit to report a Script error before the SDK retries
					// it as statements. Keep this retry only in the diagnostic control.
					if *mode != "isolate-control" {
						code = "(async()=>{" + code + "})()"
					}
					result, err := window.Page().Eval(code)
					if err != nil {
						fmt.Fprintln(os.Stderr, err)
						mygo.App.Exit(2)
						return
					}
					raw, ok := result.(string)
					if !ok {
						fmt.Fprintln(os.Stderr, "runtime probe returned a non-JSON-text result")
						mygo.App.Exit(2)
						return
					}
					parsed, err := contracts.ParseJSON([]byte(raw))
					var data []byte
					if err == nil {
						data, err = contracts.Stringify(parsed, true, false)
					}
					if err == nil {
						err = os.WriteFile(filepath.Join(*directory, "result-"+*mode+".json"), append(data, '\n'), 0600)
					}
					if err != nil {
						fmt.Fprintln(os.Stderr, err)
						mygo.App.Exit(2)
						return
					}
					if *mode == "cleanup" {
						if err := mygo.DefaultSession().ClearData(mygo.SiteDataAll); err != nil {
							fmt.Fprintln(os.Stderr, err)
							mygo.App.Exit(2)
							return
						}
					}
					mygo.App.Quit()
				}()
			})
		})
	})
	go func() {
		time.Sleep(45 * time.Second)
		fmt.Fprintln(os.Stderr, "runtime probe timed out")
		mygo.App.Exit(3)
	}()
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
