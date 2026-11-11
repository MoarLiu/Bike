//go:build darwin

package platform

import (
	"context"
	"encoding/json"
	"encoding/json/jsontext"
	jsonv2 "encoding/json/v2"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
	"github.com/egoist/mygo"
)

func TestClosePreparationWaitsForStartup(t *testing.T) {
	t.Run("subscription-and-loading", func(t *testing.T) {
		checks, requests := 0, 0
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		ok, err := prepareCloseWhenReady(ctx, func(context.Context) (bool, error) {
			checks++
			return checks > 1, nil
		}, func(context.Context) (json.RawMessage, error) {
			requests++
			if requests == 1 {
				return json.RawMessage(`{"ok":false,"loading":true}`), nil
			}
			return json.RawMessage(`{"ok":true}`), nil
		})
		if err != nil || !ok || requests != 2 || checks != 3 {
			t.Fatalf("startup close did not wait for readiness: %v %v checks=%d requests=%d", ok, err, checks, requests)
		}
	})
	t.Run("busy-is-not-retried", func(t *testing.T) {
		requests := 0
		ok, err := prepareCloseWhenReady(context.Background(), func(context.Context) (bool, error) {
			return true, nil
		}, func(context.Context) (json.RawMessage, error) {
			requests++
			return json.RawMessage(`{"ok":false}`), nil
		})
		if err != nil || ok || requests != 1 {
			t.Fatalf("busy preparation was retried: %v %v %d", ok, err, requests)
		}
	})
	t.Run("deadline-before-subscription", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
		defer cancel()
		ok, err := prepareCloseWhenReady(ctx, func(context.Context) (bool, error) {
			return false, nil
		}, func(context.Context) (json.RawMessage, error) {
			t.Fatal("request was sent before its listener existed")
			return nil, nil
		})
		if ok || !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("startup deadline was not preserved: %v %v", ok, err)
		}
		desktop := NewDesktop(product.Info{}, t.TempDir(), "")
		if _, err := desktop.Request(ctx, "prepareUpdate", nil); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("an expired request was not rejected before delivery: %v", err)
		}
	})
}

func TestDesktopTeardownCancelsUploads(t *testing.T) {
	for _, action := range []string{"detach", "close", "navigation", "renderer-gone"} {
		t.Run(action, func(t *testing.T) {
			profile := t.TempDir()
			desktop := NewDesktop(product.Info{}, profile, filepath.Join(profile, "cloud"))
			t.Cleanup(desktop.Close)
			window := &mygo.Window{}
			desktop.SetWindow(window)
			if err := desktop.Library.BeginUpload(context.Background(), "pending", "partial.txt", 1); err != nil {
				t.Fatal(err)
			}
			files, err := filepath.Glob(filepath.Join(desktop.Library.Directory, ".upload-*.tmp"))
			if err != nil || len(files) != 1 {
				t.Fatalf("missing upload fixture: %v %v", files, err)
			}
			switch action {
			case "detach":
				desktop.Detach(window)
			case "close":
				desktop.Close()
			case "navigation":
				desktop.SetWindow(window)
			case "renderer-gone":
				desktop.cancelUploads()
			}
			if desktop.uploadsReady != (action == "navigation") {
				t.Fatal("upload admission did not follow the page lifecycle")
			}
			if _, err := os.Stat(files[0]); !os.IsNotExist(err) {
				t.Fatalf("desktop teardown retained upload: %v", err)
			}
		})
	}
}

func TestWorkspaceJSONSurvivesTheNativeIPCCodec(t *testing.T) {
	raw := json.RawMessage(`{"text":"\ud800","nested":{"z":1,"a":2}}`)
	for _, field := range []string{"workspace", "payload"} {
		value := desktopJSONField(map[string]any{field: raw}, field)
		encoded, err := jsonv2.Marshal(value, jsontext.EscapeForJS(true))
		if err != nil {
			t.Fatalf("native IPC rejected lossless %s: %v", field, err)
		}
		var decoded map[string]string
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatal(err)
		}
		if decoded[field+"JSON"] != string(raw) {
			t.Fatal("Unicode or property order changed across native IPC")
		}
		if _, exists := value[field]; exists {
			t.Fatal("strict codec still receives the raw workspace value")
		}
	}
}

func TestArchiveEnvelopeKeepsBothContentBudgets(t *testing.T) {
	// A 36 MiB workspace plus 36 MiB readable HTML is valid per field.
	combined := 72 * 1024 * 1024
	if desktopRequestBudget("exportWorkspaceArchive") < combined {
		t.Fatal("valid portable archive envelope rejected")
	}
	if desktopRequestBudget("exportWorkspaceArchive") > 132*1024*1024 {
		t.Fatal("archive envelope lost its combined bound")
	}
	if desktopRequestBudget("info") >= combined {
		t.Fatal("unrelated request budget expanded")
	}
}

func TestNavigationBoundary(t *testing.T) {
	for _, raw := range []string{"https://example.com", "file:///tmp/page.html", "mygo://other/", "mygo://user@localhost/", "mygo://localhost:80/", "javascript:alert(1)"} {
		if trustedNavigation(raw) {
			t.Fatalf("trusted unexpected navigation %s", raw)
		}
	}
	if !trustedNavigation("mygo://localhost/") {
		t.Fatal("production origin rejected")
	}
}
