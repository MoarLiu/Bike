//go:build darwin

package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/frontend"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/services"
	"github.com/egoist/mygo"
)

// Run uses the default WebKit data store. Named MyGO sessions are volatile on
// macOS 12/13. The installed bundle identifier isolates this default store.
func Run(info product.Info) error {
	if os.Getenv("MYGO_GENERATE") != "" {
		mygo.BindAs("BikeHost", host{info: info})
		BindDesktop(NewDesktop(info, "", ""))
		return mygo.App.Run()
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	if filepath.Base(filepath.Dir(executable)) != "MacOS" || filepath.Base(filepath.Dir(filepath.Dir(executable))) != "Contents" {
		return fmt.Errorf("open the built %s.app bundle to use its isolated WebKit data store", info.Name)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	files, err := frontend.Files()
	if err != nil {
		return err
	}
	mygo.App.SetName(info.Name)
	mygo.App.SetVersion(info.Version)
	mygo.App.SetPath(mygo.PathUserData, info.ProfilePath(home))
	mygo.SetFrontend(files)
	mygo.BindAs("BikeHost", host{info: info})
	profile := info.ProfilePath(home)
	if err := os.MkdirAll(profile, 0700); err != nil {
		return err
	}
	metadata, err := os.Lstat(profile)
	if err != nil || !metadata.IsDir() || metadata.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("MyGO profile 目录无效")
	}
	desktop := NewDesktop(info, profile, filepath.Join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", info.BackupDirectory))
	BindDesktop(desktop)
	mygo.App.OnQuit(desktop.Close)
	if !mygo.App.RequestSingleInstanceLock() {
		return nil
	}
	if err := os.Remove(filepath.Join(profile, "live-mcp.json")); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("无法清理旧 Live 授权发现文件")
	}
	if err := desktop.Library.RecoverUploads(); err != nil {
		return fmt.Errorf("清理未完成附件传输失败：%w", err)
	}
	_ = services.CleanupOpenFiles()
	var window *mygo.Window
	var allowQuit, preparing atomic.Bool
	openWindow := func() {
		options := mygo.WindowOptions{Title: info.Name, Width: 1366, Height: 960, MinWidth: 1366, MinHeight: 960, URL: "/"}
		if raw, err := os.ReadFile(filepath.Join(profile, "window.json")); err == nil {
			var bounds mygo.Rectangle
			if json.Unmarshal(raw, &bounds) == nil && bounds.Width >= 1366 && bounds.Width <= 16384 && bounds.Height >= 960 && bounds.Height <= 16384 {
				visible := false
				if bounds.X >= -32768 && bounds.X <= 32768 && bounds.Y >= -32768 && bounds.Y <= 32768 {
					for _, display := range mygo.Screen.Displays() {
						area := display.WorkArea
						if bounds.X+128 > area.X && bounds.X < area.X+area.Width-64 && bounds.Y+32 > area.Y && bounds.Y < area.Y+area.Height-32 {
							visible = true
							break
						}
					}
				}
				if visible {
					options.Width, options.Height, options.X, options.Y = bounds.Width, bounds.Height, bounds.X, bounds.Y
				}
			}
		}
		window = mygo.NewWindow(options)
		desktop.SetWindow(window)
		owner := window
		var allowClose atomic.Bool
		window.OnClose(func(event *mygo.CloseEvent) {
			if allowClose.Load() || allowQuit.Load() {
				return
			}
			event.PreventDefault()
			if !preparing.CompareAndSwap(false, true) {
				return
			}
			go func() {
				defer preparing.Store(false)
				if desktop.PrepareClose(context.Background()) {
					allowClose.Store(true)
					owner.Close()
				}
			}()
		})
		window.OnClosed(func() { desktop.Detach(owner); window = nil })
		saveBounds := func() {
			if owner.IsDestroyed() {
				return
			}
			raw, _ := json.Marshal(owner.Bounds())
			os.WriteFile(filepath.Join(profile, "window.json"), raw, 0600)
		}
		window.OnMove(saveBounds)
		window.OnResize(saveBounds)
		window.Page().OnPageTitleUpdated(func(event *mygo.TitleEvent) { event.PreventDefault() })
		window.Page().OnDOMReady(func() { desktop.Live.Stop() })
		window.Page().OnDidNavigate(func(_ string) { desktop.SetWindow(owner) })
		window.Page().OnRenderProcessGone(func(_ string) { desktop.cancelUploads() })
		window.Page().OnWillNavigate(func(event *mygo.NavigateEvent) {
			if !trustedNavigation(event.URL) {
				event.PreventDefault()
				if event.UserInitiated && externalURL(event.URL) {
					go mygo.Shell.OpenExternal(event.URL)
				}
			}
		})
		window.Page().SetWindowOpenHandler(func(request mygo.WindowOpenRequest) *mygo.WindowOptions {
			if externalURL(request.URL) {
				go mygo.Shell.OpenExternal(request.URL)
			}
			return nil
		})
		window.Page().OnWillDownload(func(event *mygo.DownloadEvent) {
			name, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: owner, Title: "保存导出文件", DefaultPath: filepath.Base(event.SuggestedName)})
			if err != nil || name == "" {
				event.PreventDefault()
				return
			}
			event.Path = name
		})
	}
	mygo.App.WhenReady(func() { installMenu(desktop); openWindow() })
	mygo.App.OnBeforeQuit(func(event *mygo.QuitEvent) {
		if allowQuit.Load() || window == nil {
			return
		}
		event.PreventDefault()
		if !preparing.CompareAndSwap(false, true) {
			return
		}
		go func() {
			defer preparing.Store(false)
			if desktop.PrepareClose(context.Background()) {
				allowQuit.Store(true)
				mygo.App.Quit()
			}
		}()
	})
	mygo.App.OnSecondInstance(func(args []string, directory string) {
		if window == nil {
			openWindow()
		} else {
			window.Show()
			window.Focus()
		}
	})
	mygo.App.OnWindowAllClosed(func() {})
	mygo.App.OnActivate(func(visible bool) {
		if window == nil {
			openWindow()
		} else {
			window.Show()
			window.Focus()
		}
	})
	return mygo.App.Run()
}

func externalURL(raw string) bool {
	value, err := url.Parse(raw)
	return err == nil && value.User == nil && (value.Scheme == "http" || value.Scheme == "https" || value.Scheme == "mailto" || value.Scheme == "tel")
}

type host struct{ info product.Info }

func (h host) Info() product.Info { return h.info }

func trustedNavigation(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "mygo" && parsed.Host == "localhost" && parsed.User == nil
}
