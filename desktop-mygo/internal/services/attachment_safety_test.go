package services

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

func waitForUploadCleanup(t *testing.T, library *Attachments, id string, item *upload) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		library.mu.Lock()
		present := library.uploads[id] == item
		library.mu.Unlock()
		if !present {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("abandoned upload was not reclaimed")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := item.file.Stat(); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("upload descriptor remained open: %v", err)
	}
	if _, err := os.Lstat(item.file.Name()); !os.IsNotExist(err) {
		t.Fatalf("upload temporary file remained: %v", err)
	}
}

func TestAttachmentUploadLifecycleCleanup(t *testing.T) {
	for _, reason := range []string{"page-cancel", "timeout", "expired-clean", "shutdown"} {
		t.Run(reason, func(t *testing.T) {
			library := NewAttachments(filepath.Join(t.TempDir(), "attachments"))
			t.Cleanup(library.CancelUploads)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if err := library.BeginUpload(ctx, "upload", "partial.txt", 4); err != nil {
				t.Fatal(err)
			}
			if err := library.UploadChunk("upload", 0, base64.StdEncoding.EncodeToString([]byte("part"))); err != nil {
				t.Fatal(err)
			}
			library.mu.Lock()
			item := library.uploads["upload"]
			library.mu.Unlock()
			switch reason {
			case "page-cancel":
				cancel()
			case "timeout":
				library.mu.Lock()
				item.expires = time.Now().Add(-time.Second)
				item.timer.Reset(0)
				library.mu.Unlock()
			case "expired-clean":
				scan, err := library.Scan(nil)
				if err != nil {
					t.Fatal(err)
				}
				library.mu.Lock()
				item.expires = time.Now().Add(-time.Second)
				library.mu.Unlock()
				if _, err := library.Clean(nil, scan["ticket"].(string)); err != nil {
					t.Fatalf("expired upload still blocked cleanup: %v", err)
				}
			case "shutdown":
				library.CancelUploads()
			}
			waitForUploadCleanup(t, library, "upload", item)
			if err := library.BeginUpload(context.Background(), "upload", "new.txt", 4); err != nil {
				t.Fatal(err)
			}
			cancel()
			if err := library.UploadChunk("upload", 0, base64.StdEncoding.EncodeToString([]byte("next"))); err != nil {
				t.Fatalf("old page cancellation affected a new upload: %v", err)
			}
			if _, err := library.FinishUpload(context.Background(), "upload"); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRecoverInterruptedUploadFiles(t *testing.T) {
	library := NewAttachments(filepath.Join(t.TempDir(), "attachments"))
	if err := library.RecoverUploads(); err != nil {
		t.Fatal(err)
	}
	orphan, err := os.CreateTemp(library.Directory, ".upload-*.tmp")
	if err != nil {
		t.Fatal(err)
	}
	orphan.WriteString("interrupted")
	orphan.Close()
	retained := filepath.Join(library.Directory, ".import-keep.tmp")
	if err := os.WriteFile(retained, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(library.Directory, ".upload-link.tmp")
	if err := os.Symlink(retained, link); err != nil {
		t.Fatal(err)
	}
	if err := library.BeginUpload(context.Background(), "active", "active.txt", 1); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(library.CancelUploads)
	if err := library.RecoverUploads(); err == nil {
		t.Fatal("startup recovery accepted a library with live uploads")
	}
	library.CancelUploads()
	for attempt := 0; attempt < 2; attempt++ {
		if err := library.RecoverUploads(); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(orphan.Name()); !os.IsNotExist(err) {
		t.Fatalf("previous-process upload remained: %v", err)
	}
	if raw, err := os.ReadFile(retained); err != nil || string(raw) != "keep" {
		t.Fatalf("unrelated file changed: %v", err)
	}
	if _, err := os.Lstat(link); err != nil {
		t.Fatalf("recovery followed or removed a symlink: %v", err)
	}
}

func TestCleanVerifiesExistingQuarantineBeforeRemovingOriginal(t *testing.T) {
	for _, corrupt := range []bool{false, true} {
		t.Run(fmt.Sprintf("corrupt=%v", corrupt), func(t *testing.T) {
			library := NewAttachments(filepath.Join(t.TempDir(), "library"))
			original := []byte("irreplaceable original 中文🙂")
			asset := importFixture(t, library, original)
			library = NewAttachments(library.Directory)
			quarantine := filepath.Join(library.Directory, "quarantine")
			if err := os.MkdirAll(quarantine, 0700); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(quarantine, asset.AssetID[7:])
			isolated := original
			if corrupt {
				isolated = []byte("corrupted pre-existing quarantine target")
			}
			if err := os.WriteFile(target, isolated, 0600); err != nil {
				t.Fatal(err)
			}
			scan, err := library.Scan(nil)
			if err != nil {
				t.Fatal(err)
			}
			result, err := library.Clean(nil, scan["ticket"].(string))
			source, _ := library.objectPath(asset.AssetID)
			if corrupt {
				if !errors.Is(err, ErrAttachmentIntegrity) {
					t.Fatalf("expected integrity failure, got %v %v", result, err)
				}
				retained, err := os.ReadFile(source)
				if err != nil || !bytes.Equal(retained, original) {
					t.Fatalf("live original lost: %v", err)
				}
				retained, err = os.ReadFile(target)
				if err != nil || !bytes.Equal(retained, isolated) {
					t.Fatalf("corrupt evidence changed: %v", err)
				}
			} else {
				if err != nil || result["moved"] != 1 {
					t.Fatalf("valid duplicate failed %v %v", result, err)
				}
				if _, err := os.Stat(source); !os.IsNotExist(err) {
					t.Fatal("live duplicate was not quarantined")
				}
				file, _, err := library.Open(asset.AssetID, &asset.Metadata)
				if err != nil {
					t.Fatal(err)
				}
				file.Close()
			}
		})
	}
}

func TestCorruptQuarantineReadPreservesRecoveryCandidate(t *testing.T) {
	library := NewAttachments(filepath.Join(t.TempDir(), "library"))
	asset := importFixture(t, library, []byte("original"))
	library = NewAttachments(library.Directory)
	scan, _ := library.Scan(nil)
	if _, err := library.Clean(nil, scan["ticket"].(string)); err != nil {
		t.Fatal(err)
	}
	isolated := filepath.Join(library.Directory, "quarantine", asset.AssetID[7:])
	if err := os.WriteFile(isolated, []byte("damaged"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := library.Open(asset.AssetID, nil); !errors.Is(err, ErrAttachmentIntegrity) {
		t.Fatal(err)
	}
	if retained, err := os.ReadFile(isolated); err != nil || string(retained) != "damaged" {
		t.Fatalf("recovery candidate removed: %v", err)
	}
}

func TestAttachmentMetadataJSONContract(t *testing.T) {
	for _, fields := range []any{
		nil, map[string]any{}, []any{}, map[string]any{"mediaType": "application/pdf"},
		map[string]any{"mediaType": "application/pdf", "byteLength": nil},
		map[string]any{"mediaType": "application/pdf", "byteLength": 1.5},
		map[string]any{"mediaType": "application/pdf", "byteLength": 134217729},
		map[string]any{"mediaType": "application/pdf", "byteLength": 0, "width": 0},
		map[string]any{"mediaType": "application/pdf", "byteLength": 0, "height": nil},
		map[string]any{"mediaType": "application/pdf", "byteLength": 0, "width": 4294967296},
		map[string]any{"mediaType": "image/png", "byteLength": 0},
	} {
		raw, _ := json.Marshal(fields)
		var metadata Metadata
		if err := json.Unmarshal(raw, &metadata); err == nil {
			t.Fatalf("invalid metadata accepted %s", raw)
		}
	}
	for _, metadata := range []Metadata{
		{MediaType: "application/octet-stream", ByteLength: 0},
		{MediaType: "image/png", ByteLength: 24, Width: 1, Height: 1},
	} {
		raw, err := json.Marshal(metadata)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]any
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		if metadata.Width == 0 {
			if _, exists := fields["width"]; exists {
				t.Fatalf("optional zero dimension serialized: %s", raw)
			}
			if _, exists := fields["height"]; exists {
				t.Fatalf("optional zero dimension serialized: %s", raw)
			}
		}
		var decoded Metadata
		if err := json.Unmarshal(raw, &decoded); err != nil || decoded != metadata {
			t.Fatalf("metadata roundtrip %s %v", raw, err)
		}
	}
}

func TestImagePreviewPixelBudgetCannotOverflow(t *testing.T) {
	header := make([]byte, 24)
	copy(header, []byte{137, 80, 78, 71, 13, 10, 26, 10})
	copy(header[12:], "IHDR")
	binary.BigEndian.PutUint32(header[16:], 0xffffffff)
	binary.BigEndian.PutUint32(header[20:], 0xffffffff)
	library := NewAttachments(filepath.Join(t.TempDir(), "library"))
	asset := importFixture(t, library, header)
	for _, thumbnail := range []bool{false, true} {
		result, err := library.Preview(asset.AssetID, thumbnail)
		if err != nil || result["previewable"] != false {
			t.Fatalf("oversized image bypassed pixel budget: %v %v", result, err)
		}
	}
}

func TestAttachmentNamesAndAltUseSharedUTF16Limits(t *testing.T) {
	library := NewAttachments(filepath.Join(t.TempDir(), "library"))
	asset := importFixture(t, library, []byte("original"))
	source, _ := library.objectPath(asset.AssetID)
	for _, name := range []string{strings.Repeat("🙂", 512), strings.Repeat("中", 1024)} {
		if _, err := library.Import(context.Background(), source, name, false); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{strings.Repeat("🙂", 513), strings.Repeat("中", 1025), "\ufeff　"} {
		if _, err := library.Import(context.Background(), source, name, false); err == nil {
			t.Fatal("invalid import name accepted")
		}
		if err := library.BeginUpload(context.Background(), "invalid", name, 1); err == nil {
			t.Fatal("invalid upload name accepted")
		}
	}
	var workspace map[string]any
	if err := json.Unmarshal(workspaceFixture(&asset), &workspace); err != nil {
		t.Fatal(err)
	}
	ref := workspace["documents"].([]any)[0].(map[string]any)["nodes"].([]any)[0].(map[string]any)["attachmentRefs"].([]any)[0].(map[string]any)
	for _, item := range []struct {
		name  string
		alt   any
		valid bool
	}{
		{strings.Repeat("🙂", 512), strings.Repeat("🙂", 5000), true},
		{strings.Repeat("🙂", 513), "", false},
		{" \ufeff", "", false},
		{"ok", strings.Repeat("🙂", 5001), false},
		{"ok", nil, false},
	} {
		ref["name"], ref["alt"] = item.name, item.alt
		raw, _ := json.Marshal(workspace)
		_, _, _, err := WorkspaceJSON(raw)
		if (err == nil) != item.valid {
			t.Fatalf("UTF16 name/alt validation valid=%v, got %v", item.valid, err)
		}
	}
}

func TestAssetSyncConcurrentWorkersAndRunReservation(t *testing.T) {
	library := NewAttachments(filepath.Join(t.TempDir(), "library"))
	assets := []Asset{}
	for index := 0; index < 3; index++ {
		assets = append(assets, importFixture(t, library, []byte(fmt.Sprintf("original-%d", index))))
	}
	started := make(chan struct{}, 10)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		started <- struct{}{}
		select {
		case <-release:
		case <-request.Context().Done():
			return
		}
		var metadata Metadata
		if err := json.NewDecoder(request.Body).Decode(&metadata); err != nil {
			t.Error(err)
			return
		}
		json.NewEncoder(writer).Encode(map[string]any{"complete": true, "offset": metadata.ByteLength, "byteLength": metadata.ByteLength})
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	syncer := &AssetSync{Library: library, Directory: filepath.Join(t.TempDir(), "transfers"), Network: NewNetwork()}
	config := map[string]any{"serverUrl": server.URL, "token": "fixture"}
	type outcome struct {
		result map[string]any
		err    error
	}
	done := make(chan outcome, 1)
	go func() { result, err := syncer.Run(ctx, config, assets); done <- outcome{result, err} }()
	for index := 0; index < 2; index++ {
		select {
		case <-started:
		case <-ctx.Done():
			close(release)
			t.Fatal("two requests did not run concurrently")
		}
	}
	select {
	case <-started:
		close(release)
		t.Fatal("more than two transfers started")
	case <-time.After(30 * time.Millisecond):
	}
	if _, err := syncer.Run(ctx, config, assets); err == nil {
		close(release)
		t.Fatal("overlapping run accepted")
	}
	other := &AssetSync{Library: library, Directory: syncer.Directory, Network: NewNetwork()}
	if _, err := other.Run(ctx, config, assets); err == nil {
		close(release)
		t.Fatal("shared transfer directory accepted overlapping run")
	}
	close(release)
	finished := <-done
	if finished.err != nil || finished.result["completed"] != 3 || finished.result["complete"] != true {
		t.Fatalf("sync failed %v %v", finished.result, finished.err)
	}
	if _, err := other.Run(ctx, config, assets); err != nil {
		t.Fatalf("transfer lock not released: %v", err)
	}
}

func TestAssetSyncIntegrityFailureResetsOnlyItsLease(t *testing.T) {
	library := NewAttachments(filepath.Join(t.TempDir(), "library"))
	asset := importFixture(t, library, []byte("original"))
	for _, code := range []string{"asset_integrity", "asset_metadata", "asset_quota", "stale_upload"} {
		t.Run(code, func(t *testing.T) {
			var reset atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				switch {
				case request.Method == http.MethodDelete:
					var body map[string]any
					json.NewDecoder(request.Body).Decode(&body)
					if body["uploadId"] != "fixture-lease" {
						t.Error("reset targeted another lease")
					}
					reset.Store(true)
					json.NewEncoder(writer).Encode(map[string]any{"reset": true})
				case strings.HasSuffix(request.URL.Path, "/lease"):
					json.NewEncoder(writer).Encode(map[string]any{"complete": false, "offset": asset.Metadata.ByteLength, "uploadId": "fixture-lease"})
				default:
					writer.WriteHeader(422)
					json.NewEncoder(writer).Encode(map[string]any{"error": code, "message": code})
				}
			}))
			defer server.Close()
			syncer := &AssetSync{Library: library, Directory: filepath.Join(t.TempDir(), "transfers"), Network: NewNetwork()}
			result, err := syncer.Run(context.Background(), map[string]any{"serverUrl": server.URL, "token": "fixture"}, []Asset{asset})
			if err != nil || result["complete"] != false {
				t.Fatalf("bad finish accepted %v %v", result, err)
			}
			if reset.Load() != (code == "asset_integrity" || code == "asset_metadata") {
				t.Fatalf("incorrect lease reset for %s", code)
			}
		})
	}
}

func TestAssetSyncRejectsInvalidBatchBeforeNetworkOrDisk(t *testing.T) {
	syncer := &AssetSync{}
	config := map[string]any{"serverUrl": "http://127.0.0.1", "token": "fixture"}
	for _, raw := range []string{"http://127.0.0.1?", "http://127.0.0.1/#fragment", "bad"} {
		if _, err := syncer.Run(context.Background(), map[string]any{"serverUrl": raw, "token": "fixture"}, nil); err == nil {
			t.Fatal("bad URL accepted")
		}
	}
	if _, err := syncer.Run(context.Background(), config, make([]Asset, 1001)); err == nil {
		t.Fatal("overlarge batch accepted")
	}
	assets := []Asset{}
	for index := 0; index < 5; index++ {
		assets = append(assets, Asset{AssetID: fmt.Sprintf("sha256:%064x", index), Metadata: Metadata{MediaType: "application/octet-stream", ByteLength: int64(contracts.Limits.AttachmentBytes)}})
	}
	if _, err := syncer.Run(context.Background(), config, assets); err == nil {
		t.Fatal("batch bytes not bounded")
	}
	if result, err := syncer.Run(context.Background(), config, nil); err != nil || result["complete"] != true {
		t.Fatal("validation failure kept run reserved")
	}
}
