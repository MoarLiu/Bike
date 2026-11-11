//go:build darwin

// This diagnostic executable is compiled separately and never ships.
package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/frontend"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/platform"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
	"github.com/egoist/mygo"
)

//go:embed acceptance.js
var acceptanceJS string

const preload = `
window.__uiErrors = [];
window.__uiCSP = [];
window.addEventListener('error', e => window.__uiErrors.push({message:e.message, file:e.filename, line:e.lineno}));
window.addEventListener('unhandledrejection', e => window.__uiErrors.push({rejection:String(e.reason), stack:e.reason?.stack}));
window.addEventListener('securitypolicyviolation', e => window.__uiCSP.push({directive:e.violatedDirective, blocked:e.blockedURI}));
`

type download struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Completed bool   `json:"completed"`
	Error     string `json:"error,omitempty"`
	Bytes     int64  `json:"bytes"`
}

type Acceptance struct {
	directory string
	window    *mygo.Window
	mutex     sync.Mutex
	downloads []download
}

func (a *Acceptance) Resize(ctx context.Context, width, height int) error {
	if (width != 1366 || height != 960) && (width != 1728 || height != 1117) {
		return fmt.Errorf("unsupported acceptance size")
	}
	mygo.CallerWindow(ctx).SetSize(width, height)
	return nil
}

func (a *Acceptance) Capture(ctx context.Context, name string) error {
	if !regexp.MustCompile(`^(light|dark)-(1366|1728)-(outline|mindmap|presentation|markdown|menu)$`).MatchString(name) {
		return fmt.Errorf("invalid acceptance capture name")
	}
	image, err := mygo.CallerWindow(ctx).CapturePage()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(a.directory, name+".png"), image, 0600)
}

func (a *Acceptance) Downloads() []download {
	a.mutex.Lock()
	defer a.mutex.Unlock()
	return append([]download{}, a.downloads...)
}

func main() {
	mode := flag.String("mode", "", "seed, text, images, portable-html, portable-md or cleanup")
	directory := flag.String("output", "", "isolated evidence directory")
	flag.Parse()
	valid := map[string]bool{"seed": true, "text": true, "images": true, "portable-html": true, "portable-md": true, "cleanup": true}
	if !valid[*mode] || *directory == "" {
		panic("explicit acceptance mode and output required")
	}
	if err := os.MkdirAll(filepath.Join(*directory, "downloads"), 0700); err != nil {
		panic(err)
	}
	info, err := product.Current()
	if err != nil {
		panic(err)
	}
	files, err := frontend.Files()
	if err != nil {
		panic(err)
	}
	mygo.App.SetName("Bike MyGO UI Acceptance")
	mygo.App.SetVersion(info.Version)
	profile := filepath.Join(*directory, "profile")
	mygo.App.SetPath(mygo.PathUserData, profile)
	mygo.SetFrontend(files)
	desktop := platform.NewDesktop(info, profile, filepath.Join(*directory, "cloud"))
	platform.BindDesktop(desktop)
	mygo.App.OnQuit(desktop.Close)
	a := &Acceptance{directory: *directory}
	mygo.Bind(a)
	mygo.App.WhenReady(func() {
		window := mygo.NewWindow(mygo.WindowOptions{Title: "Bike MyGO UI Acceptance", Width: 1366, Height: 960, URL: "/", Page: mygo.PageOptions{PreloadScript: preload}})
		a.window = window
		desktop.SetWindow(window)
		window.Page().OnWillDownload(func(e *mygo.DownloadEvent) {
			a.mutex.Lock()
			defer a.mutex.Unlock()
			e.Path = filepath.Join(*directory, "downloads", fmt.Sprintf("%s-%02d-%s", *mode, len(a.downloads)+1, filepath.Base(e.SuggestedName)))
			a.downloads = append(a.downloads, download{Name: e.SuggestedName, Path: e.Path})
		})
		window.Page().OnDownloadDone(func(d *mygo.Download) {
			a.mutex.Lock()
			defer a.mutex.Unlock()
			for i := range a.downloads {
				if a.downloads[i].Path != d.Path {
					continue
				}
				a.downloads[i].Completed = d.Err == nil
				if d.Err != nil {
					a.downloads[i].Error = d.Err.Error()
				}
				if file, err := os.Stat(d.Path); err == nil {
					a.downloads[i].Bytes = file.Size()
				}
				break
			}
		})
		var once sync.Once
		window.Page().OnDidFinishLoad(func() {
			once.Do(func() {
				go func() {
					encoded, _ := json.Marshal(*mode)
					value, err := window.Page().Eval("(async()=>{const mode=" + string(encoded) + ";" + acceptanceJS + "})()")
					if err != nil {
						fmt.Fprintln(os.Stderr, err)
						mygo.App.Exit(2)
						return
					}
					raw, ok := value.(string)
					if !ok {
						fmt.Fprintln(os.Stderr, "acceptance script did not return JSON text")
						mygo.App.Exit(2)
						return
					}
					if err := os.WriteFile(filepath.Join(*directory, "result-"+*mode+".json"), []byte(raw+"\n"), 0600); err != nil {
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
		time.Sleep(4 * time.Minute)
		fmt.Fprintln(os.Stderr, "UI acceptance timed out")
		mygo.App.Exit(3)
	}()
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
