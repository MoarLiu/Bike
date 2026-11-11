//go:build darwin

// This executable exercises the shipping renderer with isolated fixture paths.
// It is never included in a product bundle.
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

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/frontend"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/platform"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/services"
	"github.com/egoist/mygo"
)

//go:embed migration.js
var migrationJS string

const preload = `
window.__migrationErrors = [];
window.__migrationCSP = [];
window.addEventListener("error", event => window.__migrationErrors.push({ message: event.message, stack: event.error?.stack }));
window.addEventListener("unhandledrejection", event => window.__migrationErrors.push({ rejection: String(event.reason), stack: event.reason?.stack }));
window.addEventListener("securitypolicyviolation", event => window.__migrationCSP.push({ directive: event.violatedDirective, blocked: event.blockedURI }));
`

type Migration struct {
	directory string
	phase     string
	desktop   *platform.Desktop
	mu        sync.Mutex
	exports   int
}

func (migration *Migration) Production() bool { return !mygo.IsDev() }

func (migration *Migration) Fixture() (string, error) {
	value, err := os.ReadFile(filepath.Join(migration.directory, "fixture.json"))
	return string(value), err
}

func (migration *Migration) ImportFixture(ctx context.Context) (string, error) {
	result, err := services.ImportArchive(ctx, filepath.Join(migration.directory, "source-full-copy.zip"), migration.desktop.Library)
	if err != nil {
		return "", err
	}
	// Preserve the exact workspace JSON across the diagnostic IPC boundary.
	raw, ok := result["workspace"].(json.RawMessage)
	if !ok {
		return "", fmt.Errorf("archive returned an unexpected workspace")
	}
	result["workspaceJSON"] = string(raw)
	delete(result, "workspace")
	result["ok"] = true
	encoded, err := json.Marshal(result)
	return string(encoded), err
}

func (migration *Migration) ExportCurrent(ctx context.Context, workspace string) (string, error) {
	migration.mu.Lock()
	migration.exports++
	sequence := migration.exports
	migration.mu.Unlock()
	filename := filepath.Join(migration.directory, "backups", fmt.Sprintf("%s-current-copy-%02d.zip", migration.phase, sequence))
	result, err := services.ExportArchive(ctx, filename, []byte(workspace), nil, migration.desktop.Library)
	if err != nil {
		return "", err
	}
	result["ok"] = true
	encoded, err := json.Marshal(result)
	return string(encoded), err
}

func (migration *Migration) Capture(ctx context.Context, name string) error {
	if !regexp.MustCompile(`^[a-z-]{1,60}$`).MatchString(name) {
		return fmt.Errorf("invalid capture name")
	}
	image, err := mygo.CallerWindow(ctx).CapturePage()
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(migration.directory, "captures", name+".png"), image, 0600)
}

func main() {
	mode := flag.String("mode", "", "isolated acceptance phase")
	directory := flag.String("output", "", "isolated acceptance directory")
	flag.Parse()
	validMode := map[string]bool{"seed": true, "import": true, "verify": true, "restore": true, "verify-restored": true, "seed-recovery": true, "verify-recovery": true, "cleanup": true}
	if !validMode[*mode] || *directory == "" {
		panic("explicit mode and output are required")
	}
	for _, child := range []string{"backups", "captures", "downloads"} {
		if err := os.MkdirAll(filepath.Join(*directory, child), 0700); err != nil {
			panic(err)
		}
	}
	info, err := product.Current()
	if err != nil {
		panic(err)
	}
	mygo.App.SetName("Bike MyGO Migration Acceptance")
	mygo.App.SetVersion(info.Version)
	mygo.App.SetPath(mygo.PathUserData, filepath.Join(*directory, "profile"))
	files, err := frontend.Files()
	if err != nil {
		panic(err)
	}
	mygo.SetFrontend(files)
	desktop := platform.NewDesktop(info, filepath.Join(*directory, "profile"), filepath.Join(*directory, "cloud"))
	mygo.Bind(&Migration{directory: *directory, phase: *mode, desktop: desktop})
	platform.BindDesktop(desktop)
	mygo.App.OnQuit(desktop.Close)
	mygo.App.WhenReady(func() {
		window := mygo.NewWindow(mygo.WindowOptions{Title: "Bike MyGO Migration Acceptance", Width: 1366, Height: 960, URL: "/", Page: mygo.PageOptions{PreloadScript: preload}})
		desktop.SetWindow(window)
		window.Page().OnWillDownload(func(event *mygo.DownloadEvent) {
			event.Path = filepath.Join(*directory, "downloads", filepath.Base(event.SuggestedName))
		})
		var once sync.Once
		window.Page().OnDidFinishLoad(func() {
			once.Do(func() {
				go func() {
					encodedMode, _ := json.Marshal(*mode)
					result, evalError := window.Page().Eval("(async()=>{const mode=" + string(encodedMode) + ";" + migrationJS + "})()")
					if evalError != nil {
						fmt.Fprintln(os.Stderr, evalError)
						mygo.App.Exit(2)
						return
					}
					raw, ok := result.(string)
					if !ok {
						fmt.Fprintln(os.Stderr, "migration acceptance returned a non-text result")
						mygo.App.Exit(2)
						return
					}
					parsed, parseError := contracts.ParseJSON([]byte(raw))
					var data []byte
					if parseError == nil {
						data, parseError = contracts.Stringify(parsed, true, false)
					}
					if parseError == nil {
						parseError = os.WriteFile(filepath.Join(*directory, "result-"+*mode+".json"), append(data, '\n'), 0600)
					}
					if parseError != nil {
						fmt.Fprintln(os.Stderr, parseError)
						mygo.App.Exit(2)
						return
					}
					if *mode == "cleanup" {
						if clearError := mygo.DefaultSession().ClearData(mygo.SiteDataAll); clearError != nil {
							fmt.Fprintln(os.Stderr, clearError)
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
		time.Sleep(90 * time.Second)
		fmt.Fprintln(os.Stderr, "migration acceptance timed out")
		mygo.App.Exit(3)
	}()
	if err := mygo.App.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
