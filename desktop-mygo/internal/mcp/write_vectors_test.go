package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
	protocol "github.com/modelcontextprotocol/go-sdk/mcp"
)

type writeVector struct {
	Label         string          `json:"label"`
	Raw           string          `json:"raw"`
	Name          string          `json:"name"`
	Mode          string          `json:"mode"`
	Args          json.RawMessage `json:"args"`
	Expected      json.RawMessage `json:"expected"`
	ExpectedError string          `json:"expectedError"`
	NextRaw       string          `json:"nextRaw"`
	NextDigest    string          `json:"nextDigest"`
}

func writeVectors(t *testing.T) []writeVector {
	t.Helper()
	raw, err := os.ReadFile("../../tests/fixtures/mcp-write-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []writeVector
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 70 {
		t.Fatalf("write coverage shrank to %d vectors", len(cases))
	}
	return cases
}

func parseWriteObject(t *testing.T, raw []byte) *object {
	t.Helper()
	value, err := contracts.ParseJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	result := asObject(value)
	if result == nil {
		t.Fatal("expected an object")
	}
	return result
}

func assertWriteJSON(t *testing.T, actual, expected *object) {
	t.Helper()
	wanted, err := contracts.Stringify(expected, false, true)
	if err != nil {
		t.Fatal(err)
	}
	got, err := contracts.Stringify(actual, false, true)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(wanted) {
		t.Fatalf("write result differs\nactual %s\nexpected %s", got, wanted)
	}
}

func writeFixtureStore(t *testing.T, raw, mode string) FileStore {
	t.Helper()
	name := filepath.Join(t.TempDir(), "workspace.json")
	if err := os.WriteFile(name, []byte(raw), 0640); err != nil {
		t.Fatal(err)
	}
	return FileStore{Path: name, Mode: mode}
}

func assertFileText(t *testing.T, name, expected string) {
	t.Helper()
	actual, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	if string(actual) != expected {
		t.Fatalf("%s bytes differ from expected workspace", filepath.Base(name))
	}
}

func TestWritePreviewsMatchJavaScript(t *testing.T) {
	for _, fixture := range writeVectors(t) {
		t.Run(fixture.Label, func(t *testing.T) {
			store := writeFixtureStore(t, fixture.Raw, fixture.Mode)
			args := parseWriteObject(t, fixture.Args)
			result, err := store.Mutate(context.Background(), fixture.Name, args)
			assertFileText(t, store.Path, fixture.Raw)
			entries, readErr := os.ReadDir(filepath.Dir(store.Path))
			if readErr != nil || len(entries) != 1 {
				t.Fatalf("preview or rejected write left files: %v %v", entries, readErr)
			}
			if fixture.ExpectedError != "" {
				if err == nil || err.Error() != fixture.ExpectedError {
					t.Fatalf("actual error %v, expected %s", err, fixture.ExpectedError)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			assertWriteJSON(t, result, parseWriteObject(t, fixture.Expected))
			snapshot, err := store.Load(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			before, _ := contracts.Stringify(snapshot.Ordered, false, false)
			at, err := writeTime(args.String("writeTimestamp"))
			if err != nil {
				t.Fatal(err)
			}
			preview, next, err := previewWrite(snapshot, fixture.Name, args, at)
			if err != nil {
				t.Fatal(err)
			}
			assertWriteJSON(t, preview, result)
			after, _ := contracts.Stringify(snapshot.Ordered, false, false)
			if string(before) != string(after) {
				t.Fatal("preview mutated the caller snapshot")
			}
			if string(next) != fixture.NextRaw {
				t.Fatalf("serialized workspace differs\nactual %s\nexpected %s", next, fixture.NextRaw)
			}
			digest, err := contracts.Digest(parseWriteObject(t, next))
			if err != nil || digest != fixture.NextDigest {
				t.Fatalf("canonical workspace hash %s differs from %s: %v", digest, fixture.NextDigest, err)
			}
		})
	}
}

func TestFileWritesPersistAllEightToolsForV1AndV2(t *testing.T) {
	for _, fixture := range writeVectors(t) {
		if !strings.HasPrefix(fixture.Label, "v1-") && !strings.HasPrefix(fixture.Label, "v2-") {
			continue
		}
		t.Run(fixture.Label, func(t *testing.T) {
			store := writeFixtureStore(t, fixture.Raw, "write")
			args := parseWriteObject(t, fixture.Args)
			preview, err := store.Mutate(context.Background(), fixture.Name, args)
			if err != nil {
				t.Fatal(err)
			}
			result, err := store.Mutate(context.Background(), fixture.Name, preview.Child("confirmationArgs"))
			if err != nil {
				t.Fatal(err)
			}
			assertFileText(t, store.Path, fixture.NextRaw)
			if result.Get("applied") != true || result.Get("dryRun") != false || result.String("nextWorkspaceRevision") != preview.String("nextWorkspaceRevision") {
				t.Fatal("confirmed write did not match preview")
			}
			backup := result.Child("snapshot")
			if backup == nil || backup.Get("pathIsRedacted") != true || backup.String("createdAt") != args.String("writeTimestamp") {
				t.Fatal("missing redacted backup receipt")
			}
			backupPath := filepath.Join(filepath.Dir(store.Path), backup.String("path"))
			if filepath.Dir(backupPath) != filepath.Join(filepath.Dir(store.Path), ".backups") || filepath.Base(backupPath) != backup.String("filename") {
				t.Fatal("backup receipt escaped the backup directory")
			}
			assertFileText(t, backupPath, fixture.Raw)
			info, err := os.Stat(backupPath)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatalf("backup permissions: %v %v", info, err)
			}
			info, err = os.Stat(store.Path)
			if err != nil || info.Mode().Perm() != 0640 {
				t.Fatalf("workspace permissions: %v %v", info, err)
			}
			_, err = store.Mutate(context.Background(), fixture.Name, preview.Child("confirmationArgs"))
			if err == nil || !strings.Contains(err.Error(), "revision 冲突") {
				t.Fatalf("stale confirmation returned %v", err)
			}
			assertFileText(t, store.Path, fixture.NextRaw)
			entries, err := os.ReadDir(filepath.Join(filepath.Dir(store.Path), ".backups"))
			if err != nil || len(entries) != 1 {
				t.Fatalf("stale confirmation created another backup: %v %v", entries, err)
			}
		})
	}
}

func TestFileWriteToolsThroughMCPClient(t *testing.T) {
	info, err := product.Current()
	if err != nil {
		t.Fatal(err)
	}
	for _, fixture := range writeVectors(t) {
		if !strings.HasPrefix(fixture.Label, "v1-") {
			continue
		}
		t.Run(fixture.Name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			store := writeFixtureStore(t, fixture.Raw, "write")
			server, err := newServer(store, info)
			if err != nil {
				t.Fatal(err)
			}
			clientTransport, serverTransport := protocol.NewInMemoryTransports()
			serverSession, err := server.Connect(ctx, serverTransport, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer serverSession.Close()
			client := protocol.NewClient(&protocol.Implementation{Name: "write-contract-test", Version: "2.0.0"}, nil)
			session, err := client.Connect(ctx, clientTransport, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			call := func(args any) *object {
				t.Helper()
				reply, err := session.CallTool(ctx, &protocol.CallToolParams{Name: fixture.Name, Arguments: args})
				if err != nil || reply.IsError {
					t.Fatalf("MCP write failed: %+v %v", reply, err)
				}
				encoded, err := json.Marshal(reply.StructuredContent)
				if err != nil {
					t.Fatal(err)
				}
				return parseWriteObject(t, encoded)
			}
			preview := call(parseWriteObject(t, fixture.Args))
			if preview.Get("applied") != false || preview.Get("dryRun") != true {
				t.Fatal("MCP preview wrote the workspace")
			}
			assertFileText(t, store.Path, fixture.Raw)
			result := call(preview.Child("confirmationArgs"))
			if result.Get("applied") != true || result.String("nextWorkspaceRevision") != preview.String("nextWorkspaceRevision") {
				t.Fatal("MCP confirmation did not persist the preview")
			}
			assertFileText(t, store.Path, fixture.NextRaw)
		})
	}
}

func TestFileWriteCASAcrossConcurrentStores(t *testing.T) {
	fixture := writeVectors(t)[0]
	store := writeFixtureStore(t, fixture.Raw, "write")
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, title := range []string{"first", "second"} {
		go func(title string) {
			<-start
			_, err := (FileStore{Path: store.Path, Mode: "write"}).Mutate(context.Background(), "update_document_title", ordered("documentId", "doc", "title", title, "expectedRevision", hashRaw([]byte(fixture.Raw)), "dryRun", false, "writeTimestamp", "2026-11-11T00:00:00.000Z"))
			results <- err
		}(title)
	}
	close(start)
	successes, conflicts := 0, 0
	for range 2 {
		err := <-results
		if err == nil {
			successes++
		} else if strings.Contains(err.Error(), "revision 冲突") {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes %d, conflicts %d", successes, conflicts)
	}
	entries, err := os.ReadDir(filepath.Join(filepath.Dir(store.Path), ".backups"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("concurrent backup count: %v %v", entries, err)
	}
	assertFileText(t, filepath.Join(filepath.Dir(store.Path), ".backups", entries[0].Name()), fixture.Raw)
}

func TestGeneratedWriteIDsReplayFromConfirmation(t *testing.T) {
	for _, operation := range []string{"create_document", "create_node", "append_children"} {
		t.Run(operation, func(t *testing.T) {
			fixture := writeVectors(t)[0]
			store := writeFixtureStore(t, fixture.Raw, "write")
			args := ordered("documentId", "doc", "id", "root", "text", "new", "expectedRevision", hashRaw([]byte(fixture.Raw)))
			if operation == "append_children" {
				args.Set("children", []any{ordered("id", "root"), ordered("id", "root")})
			}
			preview, err := store.Mutate(context.Background(), operation, args)
			if err != nil {
				t.Fatal(err)
			}
			if preview.Get("dryRun") != true || preview.Get("applied") != false {
				t.Fatal("write did not default to preview")
			}
			assertFileText(t, store.Path, fixture.Raw)
			ids := preview.Child("affected").Array("nodeIds")
			seen := map[string]bool{}
			for _, raw := range ids {
				id := raw.(string)
				if !strings.HasPrefix(id, "node_") || seen[id] || id == "root" {
					t.Fatalf("generated ID collided or has wrong format: %s", id)
				}
				seen[id] = true
			}
			result, err := store.Mutate(context.Background(), operation, preview.Child("confirmationArgs"))
			if err != nil {
				t.Fatal(err)
			}
			if result.String("nextWorkspaceRevision") != preview.String("nextWorkspaceRevision") {
				t.Fatal("generated IDs or timestamp changed after confirmation")
			}
		})
	}
}

func TestDeletingFinalRootCreatesDefaultNode(t *testing.T) {
	fixture := writeVectors(t)[0]
	store := writeFixtureStore(t, fixture.Raw, "write")
	result, err := store.Mutate(context.Background(), "delete_node", ordered("documentId", "doc", "nodeId", "root", "dryRun", false, "expectedRevision", hashRaw([]byte(fixture.Raw))))
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	document, err := documentByID(snapshot.Ordered, "doc")
	if err != nil {
		t.Fatal(err)
	}
	nodes := document.Array("nodes")
	if len(nodes) != 1 || asObject(nodes[0]).String("text") != "未命名主题" || !strings.HasPrefix(asObject(nodes[0]).String("id"), "node_") {
		t.Fatal("last-root deletion did not create the default node")
	}
	if len(result.Child("affected").Array("nodeIds")) != 2 {
		t.Fatal("subtree deletion did not report both removed nodes")
	}
}

func TestFileWriteLockCancellationAndOwnership(t *testing.T) {
	store := writeFixtureStore(t, writeVectors(t)[0].Raw, "write")
	release, err := acquireFileLock(context.Background(), store.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	if _, err := acquireFileLock(ctx, store.Path); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lock wait ignored cancellation: %v", err)
	}
	lockPath := filepath.Join(filepath.Dir(store.Path), ".workspace.json.lock")
	replacement, _ := json.Marshal(map[string]any{"ownerToken": "other-owner", "pid": 1})
	if err := os.WriteFile(lockPath, replacement, 0600); err != nil {
		t.Fatal(err)
	}
	release()
	assertFileText(t, lockPath, string(replacement))
}

func TestFileWriteReclaimsOnlyDeadStaleLocks(t *testing.T) {
	dead, _ := json.Marshal(map[string]any{"ownerToken": "dead", "pid": 1073741824})
	ownerless, _ := json.Marshal(map[string]any{"pid": os.Getpid()})
	for _, raw := range []string{string(dead), "invalid json", string(ownerless)} {
		t.Run(raw, func(t *testing.T) {
			store := writeFixtureStore(t, writeVectors(t)[0].Raw, "write")
			lockPath := filepath.Join(filepath.Dir(store.Path), ".workspace.json.lock")
			if err := os.WriteFile(lockPath, []byte(raw), 0600); err != nil {
				t.Fatal(err)
			}
			old := time.Now().Add(-11 * time.Minute)
			if err := os.Chtimes(lockPath, old, old); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			release, err := acquireFileLock(ctx, store.Path)
			if err != nil {
				t.Fatal(err)
			}
			release()
			if _, err := os.Lstat(lockPath); !os.IsNotExist(err) {
				t.Fatalf("released lock exists: %v", err)
			}
		})
	}
}

func TestFileWriteKeepsLiveStaleLock(t *testing.T) {
	store := writeFixtureStore(t, writeVectors(t)[0].Raw, "write")
	lockPath := filepath.Join(filepath.Dir(store.Path), ".workspace.json.lock")
	raw, _ := json.Marshal(map[string]any{"ownerToken": "live-node-owner", "pid": os.Getpid()})
	if err := os.WriteFile(lockPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-11 * time.Minute)
	if err := os.Chtimes(lockPath, old, old); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 80*time.Millisecond)
	defer cancel()
	if _, err := acquireFileLock(ctx, store.Path); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("live owner lost its stale lock: %v", err)
	}
	assertFileText(t, lockPath, string(raw))
}

func TestFileWriteRejectsIrregularLocksWithoutBlocking(t *testing.T) {
	for _, kind := range []string{"symlink", "directory", "oversized"} {
		t.Run(kind, func(t *testing.T) {
			store := writeFixtureStore(t, writeVectors(t)[0].Raw, "write")
			lockPath := filepath.Join(filepath.Dir(store.Path), ".workspace.json.lock")
			var err error
			switch kind {
			case "symlink":
				err = os.Symlink(store.Path, lockPath)
			case "directory":
				err = os.Mkdir(lockPath, 0700)
			case "oversized":
				err = os.WriteFile(lockPath, []byte(strings.Repeat("x", 4097)), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if _, err := acquireFileLock(ctx, store.Path); err == nil || errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("irregular lock was accepted or blocked: %v", err)
			}
		})
	}
}

func TestFileWriteFailuresKeepOriginalBytes(t *testing.T) {
	for _, kind := range []string{"cancelled", "backup-file", "backup-symlink", "workspace-symlink", "unknown-tool"} {
		t.Run(kind, func(t *testing.T) {
			fixture := writeVectors(t)[0]
			store := writeFixtureStore(t, fixture.Raw, "write")
			ctx := context.Background()
			operation := "update_document_title"
			backupPath := filepath.Join(filepath.Dir(store.Path), ".backups")
			switch kind {
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "backup-file":
				if err := os.WriteFile(backupPath, []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			case "backup-symlink":
				if err := os.Symlink(t.TempDir(), backupPath); err != nil {
					t.Fatal(err)
				}
			case "workspace-symlink":
				target := filepath.Join(filepath.Dir(store.Path), "target.json")
				if err := os.Rename(store.Path, target); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, store.Path); err != nil {
					t.Fatal(err)
				}
			case "unknown-tool":
				operation = "unknown"
			}
			_, err := store.Mutate(ctx, operation, ordered("documentId", "doc", "title", "new", "expectedRevision", hashRaw([]byte(fixture.Raw)), "dryRun", false))
			if err == nil {
				t.Fatal("unsafe or cancelled write succeeded")
			}
			assertFileText(t, store.Path, fixture.Raw)
			if _, err := os.Lstat(filepath.Join(filepath.Dir(store.Path), ".workspace.json.lock")); !os.IsNotExist(err) {
				t.Fatalf("failure left lock: %v", err)
			}
		})
	}
}

func TestFileWriteBackupRetention(t *testing.T) {
	directory := t.TempDir()
	keep := "bike-mcp-oldest.json"
	for index := range 24 {
		name := fmt.Sprintf("bike-mcp-%02d.json", index)
		if index == 0 {
			name = keep
		}
		file := filepath.Join(directory, name)
		if err := os.WriteFile(file, []byte("backup"), 0600); err != nil {
			t.Fatal(err)
		}
		at := time.Now().Add(time.Duration(index-24) * time.Hour)
		if err := os.Chtimes(file, at, at); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(directory, "unrelated.json"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := pruneFileBackups(directory, keep); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 21 {
		t.Fatalf("retention kept %d entries: %v", len(entries), err)
	}
	assertFileText(t, filepath.Join(directory, keep), "backup")
	assertFileText(t, filepath.Join(directory, "unrelated.json"), "keep")
}

func TestFileWriteBackupByteRetention(t *testing.T) {
	directory := t.TempDir()
	keep := "bike-mcp-latest.json"
	for _, name := range []string{keep, "bike-mcp-older.json"} {
		file, err := os.Create(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		// Sparse files exercise the byte cap without allocating a large buffer.
		err = file.Truncate(int64(contracts.Limits.DocumentBytes/2) + 1)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := pruneFileBackups(directory, keep); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(directory)
	if err != nil || len(entries) != 1 || entries[0].Name() != keep {
		t.Fatalf("byte retention did not retain only the latest backup: %v %v", entries, err)
	}
}

func TestSerializedConfirmationClearsCodeLanguage(t *testing.T) {
	raw := `{"version":1,"documents":[{"id":"doc","title":"Document","createdAt":"2026-11-11T00:00:00.000Z","updatedAt":"2026-11-11T00:00:00.000Z","nodes":[{"id":"root","text":"Root","codeLanguage":"rust","children":[]}]}]}`
	store := writeFixtureStore(t, raw, "write")
	args := ordered("documentId", "doc", "nodeId", "root", "codeLanguage", "", "expectedRevision", hashRaw([]byte(raw)))
	preview, err := store.Mutate(context.Background(), "update_node", args)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := contracts.Stringify(preview.Child("confirmationArgs"), false, false)
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.Mutate(context.Background(), "update_node", parseWriteObject(t, encoded))
	if err != nil {
		t.Fatal(err)
	}
	if result.Get("nextWorkspaceRevision") != preview.Get("nextWorkspaceRevision") {
		t.Fatal("serialized confirmation changed the preview")
	}
	snapshot, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	document, err := documentByID(snapshot.Ordered, "doc")
	if err != nil {
		t.Fatal(err)
	}
	if asObject(document.Array("nodes")[0]).Has("codeLanguage") {
		t.Fatal("cleared language remained")
	}
}

func TestFileWritePreservesUnicodeIdentitiesAndBindings(t *testing.T) {
	const nodeID = "\u0085root\u0085"
	const link = "[[Doc#Original]]"
	const at = "2026-11-11T00:00:00.000Z"
	for _, version := range []float64{1, 2} {
		t.Run(fmt.Sprintf("v%.0f", version), func(t *testing.T) {
			workspace := ordered("version", version, "activeDocumentId", "doc",
				"documents", []any{ordered("id", "doc", "title", "Doc", "createdAt", at, "updatedAt", at,
					"nodes", []any{
						ordered("id", nodeID, "text", "Original", "children", []any{}),
						ordered("id", "other", "text", link, "children", []any{}),
					},
					"knowledge", ordered("version", float64(1), "relations", []any{},
						"references", []any{ordered("id", "ref", "labelMode", "auto",
							"source", ordered("kind", "node-field", "nodeId", "other", "field", "text",
								"start", float64(0), "end", float64(len(link)), "raw", link),
							"target", ordered("documentId", "doc", "nodeId", nodeID))}))})
			raw, err := contracts.Stringify(workspace, false, false)
			if err != nil {
				t.Fatal(err)
			}
			store := writeFixtureStore(t, string(raw), "write")
			result, err := store.Mutate(context.Background(), "update_node", ordered(
				"documentId", "doc", "nodeId", "other", "note", "Unrelated edit",
				"expectedRevision", hashRaw(raw), "dryRun", false, "writeTimestamp", at))
			if err != nil || result.Get("applied") != true {
				t.Fatalf("unrelated write failed: %v", err)
			}
			persisted, err := os.ReadFile(store.Path)
			if err != nil {
				t.Fatal(err)
			}
			document, err := documentByID(parseWriteObject(t, persisted), "doc")
			if err != nil {
				t.Fatal(err)
			}
			targetID := asObject(document.Child("knowledge").Array("references")[0]).Child("target").String("nodeId")
			if targetID != nodeID {
				t.Fatalf("binding identity changed: %q", targetID)
			}
			if _, _, _, err := nodeByID(document, targetID); err != nil {
				t.Fatalf("unrelated write left a dangling binding: %v", err)
			}
			other, _, _, err := nodeByID(document, "other")
			if err != nil || other.String("note") != "Unrelated edit" {
				t.Fatal("requested edit was not persisted")
			}
			assertFileText(t, filepath.Join(filepath.Dir(store.Path), result.Child("snapshot").String("path")), string(raw))
		})
	}
}
