//go:build darwin

// Separate development-only WKWebView regression executable.
package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/frontend"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/platform"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
	"github.com/egoist/mygo"
)

//go:embed acceptance.js
var acceptanceJS string

type Layout struct{ directory string }

func (l Layout) Checkpoint(value map[string]any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(l.directory, "checkpoints.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(raw, '\n'))
	return err
}

func (l Layout) Capture(ctx context.Context) error {
	image, err := mygo.CallerWindow(ctx).CapturePage()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(l.directory, "window.png"), image, 0600)
}

func main() {
	mode := flag.String("mode", "", "seed, measure, verify or cleanup")
	directory := flag.String("output", "", "isolated regression directory")
	css := flag.String("css", "original", "original or block CSS override")
	count := flag.Int("count", 20000, "fixture topics")
	edits := flag.Int("edits", 2, "independently persisted edits, at most 50")
	expanded := flag.Bool("expanded", false, "expand all fixture rows")
	timeout := flag.Duration("timeout", 120*time.Second, "external process deadline")
	flag.Parse()
	if *directory == "" || (*mode != "seed" && *mode != "measure" && *mode != "verify" && *mode != "cleanup") ||
		(*css != "original" && *css != "block") || *count < 1 || *count > 20000 || *edits < 1 || *edits > 50 {
		panic("explicit bounded layout acceptance configuration required")
	}
	if err := os.MkdirAll(*directory, 0700); err != nil {
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
	mygo.App.SetName("Bike MyGO Layout Acceptance")
	mygo.App.SetVersion(info.Version)
	profile := filepath.Join(*directory, "profile")
	mygo.App.SetPath(mygo.PathUserData, profile)
	mygo.SetFrontend(files)
	desktop := platform.NewDesktop(info, profile, filepath.Join(*directory, "cloud"))
	platform.BindDesktop(desktop)
	mygo.App.OnQuit(desktop.Close)
	mygo.BindAs("Layout", Layout{directory: *directory})
	mygo.App.WhenReady(func() {
		if *mode == "seed" || *mode == "cleanup" {
			if err := mygo.DefaultSession().ClearData(mygo.SiteDataAll); err != nil {
				fmt.Fprintln(os.Stderr, err)
				mygo.App.Exit(2)
				return
			}
		}
		if *mode == "cleanup" {
			mygo.App.Quit()
			return
		}
		window := mygo.NewWindow(mygo.WindowOptions{Title: "Bike MyGO Layout Acceptance", Width: 1366, Height: 960, URL: "/"})
		desktop.SetWindow(window)
		mygo.App.Focus()
		window.Focus()
		var once sync.Once
		window.Page().OnDidFinishLoad(func() {
			once.Do(func() {
				go func() {
					config, _ := json.Marshal(map[string]any{"mode": *mode, "css": *css, "count": *count, "edits": *edits, "expanded": *expanded})
					value, evaluationError := window.Page().Eval("(async()=>{const config=" + string(config) + ";" + acceptanceJS + "})()")
					result := map[string]any{"result": value, "production": !mygo.IsDev(), "identity": info}
					if evaluationError != nil {
						result["error"] = evaluationError.Error()
					}
					raw, err := json.MarshalIndent(result, "", "  ")
					if err == nil {
						err = os.WriteFile(filepath.Join(*directory, "result-"+*mode+".json"), append(raw, '\n'), 0600)
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
		fmt.Fprintln(os.Stderr, "layout acceptance process deadline")
		mygo.App.Exit(3)
	}()
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
