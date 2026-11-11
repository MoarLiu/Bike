package services

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNetworkGuardsAndBudgets(t *testing.T) {
	network := NewNetwork()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/large" {
			io.WriteString(writer, strings.Repeat("x", 4097))
			return
		}
		if request.URL.Path == "/invalid" {
			io.WriteString(writer, "not-json")
			return
		}
		if request.URL.Path == "/redirect" {
			writer.Header().Set("Location", "https://example.invalid/")
			writer.WriteHeader(302)
			return
		}
		if request.Header.Get("Authorization") != "Bearer fixture-key" {
			writer.WriteHeader(401)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		io.WriteString(writer, `{"choices":[{"message":{"content":"中文🙂"}}]}`)
	}))
	defer server.Close()
	saved := map[string]any{"baseUrl": server.URL + "/v1", "endpoint": "chat_completions", "apiKey": "fixture-key"}
	request := map[string]any{"baseUrl": saved["baseUrl"], "endpoint": saved["endpoint"], "apiKey": saved["apiKey"], "requestId": "fixture", "body": map[string]any{"model": "fixture"}}
	result, err := network.AI(context.Background(), request, saved)
	if err != nil || result["ok"] != true {
		t.Fatalf("AI request failed %v %v", result, err)
	}
	request["baseUrl"] = server.URL + "/other"
	if _, err := network.AI(context.Background(), request, saved); err == nil {
		t.Fatal("unsaved endpoint accepted")
	}
	for _, route := range []string{"/large", "/invalid"} {
		if _, err := network.JSON(context.Background(), server.URL+route, "GET", "", nil, time.Second, 4096, true); err == nil {
			t.Fatalf("invalid response accepted %s", route)
		}
	}
	result, err = network.JSON(context.Background(), server.URL+"/redirect", "GET", "fixture-key", nil, time.Second, 4096, true)
	if err != nil || result["ok"] != false {
		t.Fatal("redirect followed")
	}
	for _, path := range []string{"//example.com/api/documents", "/api/v2/enable?after=1", "/api/v2/events?limit=bad", "/api/v2/assets/unknown", "/api/documents/.."} {
		if _, _, err := SyncURL(map[string]any{"serverUrl": server.URL, "pathname": path}); err == nil {
			t.Fatalf("unsafe sync route accepted %s", path)
		}
	}
}

func importFixture(t *testing.T, library *Attachments, value []byte) Asset {
	t.Helper()
	name := filepath.Join(t.TempDir(), "原件.txt")
	if err := os.WriteFile(name, value, 0600); err != nil {
		t.Fatal(err)
	}
	asset, err := library.Import(context.Background(), name, "", false)
	if err != nil {
		t.Fatal(err)
	}
	return asset
}
func workspaceFixture(asset *Asset) []byte {
	document := map[string]any{"id": "doc", "title": "中文🙂", "nodes": []any{map[string]any{"id": "node", "text": "fixture", "children": []any{}}}}
	if asset != nil {
		document["nodes"].([]any)[0].(map[string]any)["attachmentRefs"] = []any{map[string]any{"assetId": asset.AssetID, "name": asset.Name}}
		document["attachments"] = map[string]any{"version": 1, "items": map[string]any{asset.AssetID: asset.Metadata}}
	}
	value, _ := json.Marshal(map[string]any{"version": 3, "activeDocumentId": "doc", "documents": []any{document}, "extension": map[string]any{"unicode": "中文🙂"}})
	return value
}

func TestAttachmentChunksQuarantineAndAtomicFailure(t *testing.T) {
	directory := t.TempDir()
	library := NewAttachments(filepath.Join(directory, "attachments"))
	value := bytes.Repeat([]byte("中文🙂"), 150000)
	if err := library.BeginUpload(context.Background(), "upload", "原件.txt", int64(len(value))); err != nil {
		t.Fatal(err)
	}
	if err := library.UploadChunk("upload", 1, base64.StdEncoding.EncodeToString([]byte("bad"))); err == nil {
		t.Fatal("wrong offset accepted")
	}
	for offset := 0; offset < len(value); offset += 1024 * 1024 {
		end := min(offset+1024*1024, len(value))
		if err := library.UploadChunk("upload", int64(offset), base64.StdEncoding.EncodeToString(value[offset:end])); err != nil {
			t.Fatal(err)
		}
	}
	asset, err := library.FinishUpload(context.Background(), "upload")
	if err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(directory, "saved")
	if err := library.CopyTo(context.Background(), asset.AssetID, output); err != nil {
		t.Fatal(err)
	}
	actual, _ := os.ReadFile(output)
	if !bytes.Equal(actual, value) {
		t.Fatal("original bytes changed")
	}
	if err := AtomicFile(context.Background(), output, func(writer io.Writer) error { writer.Write([]byte("partial")); return fmt.Errorf("ENOSPC fixture") }); err == nil {
		t.Fatal("failed write reported success")
	}
	actual, _ = os.ReadFile(output)
	if !bytes.Equal(actual, value) {
		t.Fatal("failed write damaged original")
	}
	// A new process has no session pins. Quarantine remains recoverable by hash.
	library = NewAttachments(library.Directory)
	scan, err := library.Scan([]string{})
	if err != nil {
		t.Fatal(err)
	}
	result, err := library.Clean([]string{}, scan["ticket"].(string))
	if err != nil || result["moved"] != 1 {
		t.Fatalf("quarantine failed %v %v", result, err)
	}
	if _, err := library.Clean([]string{}, scan["ticket"].(string)); err == nil {
		t.Fatal("scan ticket replay accepted")
	}
	file, _, err := library.Open(asset.AssetID, nil)
	if err != nil {
		t.Fatal(err)
	}
	file.Close()
	if err := os.Symlink(output, filepath.Join(library.Directory, "ab")); err != nil {
		t.Fatal(err)
	}
	if _, err := library.Scan([]string{}); err == nil {
		t.Fatal("symlink library accepted")
	}
}

func TestAtomicFilePreservesChangedDestination(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(fmt.Sprintf("existing-%t", existing), func(t *testing.T) {
			target := filepath.Join(t.TempDir(), "selected-file")
			if existing {
				if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			err := AtomicFile(context.Background(), target, func(writer io.Writer) error {
				if err := os.WriteFile(target, []byte("external current version"), 0600); err != nil {
					return err
				}
				_, err := writer.Write([]byte("candidate"))
				return err
			})
			if !errors.Is(err, errFileTargetChanged) {
				t.Fatalf("changed destination was not distinguished from write failure: %v", err)
			}
			actual, err := os.ReadFile(target)
			if err != nil || string(actual) != "external current version" {
				t.Fatalf("external destination was overwritten: %q %v", actual, err)
			}
		})
	}
}

func TestArchiveRoundTripAndMaliciousPath(t *testing.T) {
	ctx := context.Background()
	source := NewAttachments(filepath.Join(t.TempDir(), "source"))
	asset := importFixture(t, source, []byte("immutable 中文🙂"))
	workspace := workspaceFixture(&asset)
	archive := filepath.Join(t.TempDir(), "workspace.zip")
	if _, err := ExportArchive(ctx, archive, workspace, &Readable{Name: "document.md", Content: "# 中文🙂"}, source); err != nil {
		t.Fatal(err)
	}
	target := NewAttachments(filepath.Join(t.TempDir(), "target"))
	result, err := ImportArchive(ctx, archive, target)
	if err != nil || result["attachmentCount"] != 1 {
		t.Fatalf("archive failed %v %v", result, err)
	}
	file, metadata, err := target.Open(asset.AssetID, &asset.Metadata)
	if err != nil || metadata != asset.Metadata {
		t.Fatal(err)
	}
	file.Close()
	bad := filepath.Join(t.TempDir(), "bad.zip")
	output, err := os.Create(bad)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(output)
	entry, _ := writer.Create("../escape")
	entry.Write([]byte("bad"))
	writer.Close()
	output.Close()
	if _, err := ImportArchive(ctx, bad, target); err == nil {
		t.Fatal("archive traversal accepted")
	}
}

func TestBackupBaselineAndSavedSource(t *testing.T) {
	directory := t.TempDir()
	saved := workspaceFixture(nil)
	revision := int64(1)
	verify := func(_ context.Context, request BackupRequest) error {
		if request.SourceRevision != revision || !bytes.Equal(request.Workspace, saved) {
			return fmt.Errorf("stale")
		}
		return nil
	}
	service := NewBackups(filepath.Join(directory, "profile"), filepath.Join(directory, "cloud"), NewAttachments(filepath.Join(directory, "attachments")), verify)
	defer service.Close()
	request := BackupRequest{Workspace: saved, SourceRevision: revision, Manual: true}
	result, err := service.Enqueue(context.Background(), request, false)
	if err != nil || result["ok"] != true {
		t.Fatalf("backup failed %v %v", result, err)
	}
	target := filepath.Join(directory, "cloud", "bike-workspace.json")
	original, _ := os.ReadFile(target)
	if err := os.WriteFile(target, []byte("external"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err = service.Enqueue(context.Background(), request, false)
	if err != nil || result["code"] != "external-change" {
		t.Fatalf("external change not protected %v %v", result, err)
	}
	actual, _ := os.ReadFile(target)
	if string(actual) != "external" {
		t.Fatal("external file overwritten")
	}
	request.ExpectedFileHash = pointer(digestBytes(actual))
	result, err = service.Enqueue(context.Background(), request, true)
	if err != nil || result["ok"] != true {
		t.Fatalf("explicit replace failed %v %v", result, err)
	}
	actual, _ = os.ReadFile(target)
	if !bytes.Equal(actual, original) {
		t.Fatal("replacement changed content")
	}
	request.SourceRevision = 0
	result, err = service.Enqueue(context.Background(), request, false)
	if err != nil || result["code"] != "stale-source" {
		t.Fatal("uncommitted source accepted")
	}
}

type backupMutationContext struct {
	context.Context
	directory string
	prefix    string
	size      int64
	mutate    func() error
	changed   bool
	failure   error
}

func (ctx *backupMutationContext) Err() error {
	if ctx.changed {
		if ctx.failure != nil {
			return ctx.failure
		}
		return ctx.Context.Err()
	}
	entries, err := os.ReadDir(ctx.directory)
	if os.IsNotExist(err) {
		return ctx.Context.Err()
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), ctx.prefix) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Size() == ctx.size {
			// Import checks its context between reads. Mutate after the small
			// original has been copied, while prepareAssets is still running.
			ctx.changed = true
			ctx.failure = ctx.mutate()
			return ctx.failure
		}
	}
	return ctx.Context.Err()
}

func TestBackupRejectsExternalChangesDuringAssets(t *testing.T) {
	baseline := workspaceFixture(nil)
	external := bytes.Replace(baseline, []byte("fixture"), []byte("updated"), 1)
	for _, scenario := range []struct {
		name      string
		initial   []byte
		external  []byte
		replace   bool
		unchanged bool
		finalize  bool
	}{
		{name: "changed-existing", initial: baseline, external: external},
		{name: "created-during-first-backup", external: external},
		{name: "deleted-existing", initial: baseline},
		{name: "explicit-replacement-raced", initial: baseline, external: external, replace: true},
		{name: "unchanged-local-content-raced", external: external, unchanged: true},
		{name: "changed-during-final-flush", initial: baseline, external: external, finalize: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			directory := t.TempDir()
			profile := filepath.Join(directory, "profile")
			cloud := filepath.Join(directory, "cloud")
			if err := os.MkdirAll(cloud, 0700); err != nil {
				t.Fatal(err)
			}
			library := NewAttachments(filepath.Join(directory, "attachments"))
			original := []byte("small immutable backup original")
			asset := importFixture(t, library, original)
			saved := workspaceFixture(&asset)
			content, _, _, err := WorkspaceJSON(saved)
			if err != nil {
				t.Fatal(err)
			}
			initial := scenario.initial
			if scenario.unchanged {
				initial = content
			}
			target := filepath.Join(cloud, "bike-workspace.json")
			if initial != nil {
				if err := os.WriteFile(target, initial, 0600); err != nil {
					t.Fatal(err)
				}
			}
			service := NewBackups(profile, cloud, library, func(_ context.Context, request BackupRequest) error {
				if request.SourceRevision != 2 || !bytes.Equal(request.Workspace, saved) {
					return fmt.Errorf("stale fixture")
				}
				return nil
			})
			defer service.Close()
			if _, err := service.SetAuto(true); err != nil {
				t.Fatal(err)
			}
			if initial != nil {
				service.settings.BaselineHash = pointer(digestBytes(initial))
			}
			request := BackupRequest{Workspace: saved, SourceRevision: 2, Manual: scenario.replace}
			if scenario.replace {
				request.ExpectedFileHash = pointer(digestBytes(initial))
				service.settings.BaselineHash = pointer("old-unaccepted-baseline")
			}
			if err := service.persistLocked(); err != nil {
				t.Fatal(err)
			}
			ctx := &backupMutationContext{
				Context:   context.Background(),
				directory: filepath.Join(cloud, "attachments"),
				prefix:    ".import-",
				size:      int64(len(original)),
				mutate: func() error {
					if scenario.external == nil {
						return os.Remove(target)
					}
					if scenario.replace || scenario.finalize {
						incoming := target + ".incoming"
						if err := os.WriteFile(incoming, scenario.external, 0600); err != nil {
							return err
						}
						return os.Rename(incoming, target)
					}
					return os.WriteFile(target, scenario.external, 0600)
				},
			}
			if scenario.finalize {
				// AtomicFile checks cancellation after its writer/guard and before
				// flushing. Replace the target at that deterministic checkpoint.
				ctx.directory, ctx.prefix, ctx.size = cloud, ".bike-", int64(len(content))
			}
			result, err := service.Enqueue(ctx, request, scenario.replace)
			if !ctx.changed || ctx.failure != nil {
				t.Fatalf("deterministic external update did not run: %v", ctx.failure)
			}
			if err != nil || result["ok"] != false || result["code"] != "external-change" {
				t.Fatalf("racing external change was not protected: %v %v", result, err)
			}
			actual, readErr := os.ReadFile(target)
			if scenario.external == nil {
				if !os.IsNotExist(readErr) {
					t.Fatalf("deleted external target was recreated: %q %v", actual, readErr)
				}
				if result["revision"] != (*string)(nil) {
					t.Fatalf("absent target acquired a revision: %v", result["revision"])
				}
			} else {
				if readErr != nil || !bytes.Equal(actual, scenario.external) {
					t.Fatalf("external version was overwritten: %q %v", actual, readErr)
				}
				revision, ok := result["revision"].(*string)
				if !ok || revision == nil || *revision != digestBytes(scenario.external) {
					t.Fatalf("external revision was not reported: %v", result["revision"])
				}
			}
			status, err := service.Status()
			if err != nil || service.settings.Paused == nil || *service.settings.Paused != "external-change" {
				t.Fatalf("automatic backup did not pause: %v %v", status, err)
			}
			if status["pending"] != true || service.settings.LastTicket != 0 || service.settings.LastSourceRevision != 0 || service.retry != nil {
				t.Fatalf("failed backup claimed a success or scheduled a retry: %v", status)
			}
			persisted := NewBackups(profile, cloud, library, service.Verify)
			defer persisted.Close()
			reloaded, err := persisted.Status()
			if err != nil || reloaded["pending"] != true || reloaded["paused"] == nil || *reloaded["paused"].(*string) != "external-change" {
				t.Fatalf("external-change receipt did not survive reload: %v %v", reloaded, err)
			}
			if scenario.replace {
				request.ExpectedFileHash = pointer(digestBytes(scenario.external))
				result, err := persisted.Enqueue(context.Background(), request, true)
				if err != nil || result["ok"] != true || persisted.settings.Paused != nil || persisted.pending != nil {
					t.Fatalf("fresh explicit replacement did not complete: %v %v", result, err)
				}
				actual, err := os.ReadFile(target)
				if err != nil || !bytes.Equal(actual, content) {
					t.Fatalf("explicit replacement did not install the saved source: %q %v", actual, err)
				}
			}
		})
	}
}

func TestMyGoReleaseChannel(t *testing.T) {
	releases := []any{map[string]any{"tag_name": "v99.0.0", "html_url": "https://github.com/MoarLiu/Bike/releases/tag/v99.0.0"}, map[string]any{"tag_name": "mygo-v2.0.1", "html_url": "https://github.com/MoarLiu/Bike/releases/tag/mygo-v2.0.1"}, map[string]any{"tag_name": "mygo-v3.0.0", "prerelease": true}}
	selected, err := FindMyGoRelease(releases, "mygo-v")
	if err != nil || selected["version"] != "2.0.1" {
		t.Fatalf("wrong release channel %v %v", selected, err)
	}
	if CompareVersions("2.10.0", "2.9.0") != 1 {
		t.Fatal("numeric version comparison failed")
	}
}
