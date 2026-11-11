//go:build darwin

// This diagnostic controller never ships in the Bike MyGO application.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/frontend"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/platform"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
	"github.com/egoist/mygo"
)

func main() {
	directory := flag.String("output", "", "isolated diagnostic directory")
	reset := flag.Bool("reset", false, "clear only this diagnostic app's WebKit data before starting")
	cleanup := flag.Bool("cleanup", false, "clear only this diagnostic app's WebKit data and exit")
	flag.Parse()
	if *directory == "" {
		panic("an explicit isolated output directory is required")
	}
	profile := filepath.Join(*directory, "profile")
	if err := os.MkdirAll(profile, 0700); err != nil {
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
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		panic(err)
	}
	token := hex.EncodeToString(secret)
	mygo.App.SetName("Bike MyGO Host Acceptance")
	mygo.App.SetVersion(info.Version)
	mygo.App.SetPath(mygo.PathUserData, profile)
	mygo.SetFrontend(files)
	desktop := platform.NewDesktop(info, profile, filepath.Join(*directory, "cloud"))
	platform.BindDesktop(desktop)
	mygo.App.OnQuit(desktop.Close)
	var window *mygo.Window
	var generation atomic.Uint64
	var evaluations sync.Mutex
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second}
	server.Handler = http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+token {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/state":
			json.NewEncoder(writer).Encode(map[string]any{"generation": generation.Load()})
		case "/eval":
			if request.Method != http.MethodPost || generation.Load() == 0 {
				http.Error(writer, "not ready", http.StatusConflict)
				return
			}
			raw, err := io.ReadAll(io.LimitReader(request.Body, 4*1024*1024+1))
			if err != nil || len(raw) > 4*1024*1024 {
				http.Error(writer, "invalid diagnostic script", http.StatusBadRequest)
				return
			}
			evaluations.Lock()
			result, err := window.Page().Eval(string(raw))
			evaluations.Unlock()
			if err != nil {
				json.NewEncoder(writer).Encode(map[string]any{"ok": false, "error": err.Error()})
				return
			}
			text, ok := result.(string)
			if !ok || !json.Valid([]byte(text)) {
				json.NewEncoder(writer).Encode(map[string]any{"ok": false, "error": "diagnostic evaluation did not return JSON text"})
				return
			}
			writer.Write([]byte(text))
		case "/reload":
			window.Page().Reload()
			json.NewEncoder(writer).Encode(map[string]any{"ok": true})
		case "/capture":
			name := filepath.Base(request.URL.Query().Get("name"))
			if name == "." || filepath.Ext(name) != ".png" {
				http.Error(writer, "invalid capture name", http.StatusBadRequest)
				return
			}
			image, err := window.CapturePage()
			if err == nil {
				err = os.WriteFile(filepath.Join(*directory, name), image, 0600)
			}
			json.NewEncoder(writer).Encode(map[string]any{"ok": err == nil})
		case "/quit":
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			ready := desktop.PrepareClose(ctx)
			json.NewEncoder(writer).Encode(map[string]any{"ok": ready, "closeBarrier": ready})
			if ready {
				go func() { time.Sleep(100 * time.Millisecond); mygo.App.Quit() }()
			}
		default:
			http.NotFound(writer, request)
		}
	})
	mygo.App.OnQuit(func() { server.Close() })
	mygo.App.WhenReady(func() {
		if *reset || *cleanup {
			if err := mygo.DefaultSession().ClearData(mygo.SiteDataAll); err != nil {
				fmt.Fprintln(os.Stderr, err)
				mygo.App.Exit(2)
				return
			}
		}
		if *cleanup {
			mygo.App.Quit()
			return
		}
		window = mygo.NewWindow(mygo.WindowOptions{
			Title: "Bike MyGO Host Acceptance", Width: 1366, Height: 960, URL: "/",
			Page: mygo.PageOptions{PreloadScript: `
window.__hostErrors=[];
window.addEventListener('error', event=>window.__hostErrors.push({message:event.message,file:event.filename,line:event.lineno}));
window.addEventListener('unhandledrejection', event=>window.__hostErrors.push({rejection:String(event.reason)}));
`},
		})
		desktop.SetWindow(window)
		window.Page().OnDOMReady(func() { desktop.Live.Stop() })
		window.Page().OnDidFinishLoad(func() {
			if generation.Add(1) == 1 {
				json.NewEncoder(os.Stdout).Encode(map[string]any{
					"type": "ready", "url": "http://" + listener.Addr().String(),
					"token": token, "profile": profile, "pid": os.Getpid(),
				})
			}
		})
		go func() {
			if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
				fmt.Fprintln(os.Stderr, err)
				mygo.App.Exit(2)
			}
		}()
	})
	go func() {
		time.Sleep(12 * time.Minute)
		fmt.Fprintln(os.Stderr, "host acceptance controller timed out")
		mygo.App.Exit(3)
	}()
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
