package services

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

func migrationTestObject(t *testing.T, raw string) *contracts.Object {
	t.Helper()
	value, err := contracts.ParseJSON([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return value.(*contracts.Object)
}

func migrationTestSeal(t *testing.T, workspace *contracts.Object) []byte {
	t.Helper()
	copy := workspace.Child("localMigration")
	body := migrationObjectWithout(workspace, "localMigration")
	sourceDigest, err := contracts.Digest(body)
	if err != nil {
		t.Fatal(err)
	}
	copy.Child("source").Set("workspaceSha256", sourceDigest)
	value := contracts.NewObject()
	value.Set("workspace", body)
	value.Set("localMigration", migrationObjectWithout(copy, "contentSha256"))
	contentDigest, err := contracts.Digest(value)
	if err != nil {
		t.Fatal(err)
	}
	copy.Set("contentSha256", contentDigest)
	raw, err := contracts.Stringify(workspace, false, false)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func migrationTestWorkspace(t *testing.T) *contracts.Object {
	t.Helper()
	workspace := migrationTestObject(t, string(workspaceFixture(nil)))
	copy := migrationTestObject(t, `{"format":"bike-local-copy","version":1,"id":"archive","createdAt":"2026-11-11T00:00:00.000Z","source":{"actorId":null,"revision":19,"workspaceSha256":""},"history":[],"recovery":[],"recoveryFiles":[],"preAttachment":null,"preOperation":null,"sourceAudit":{"audit":[],"outbox":[],"receipts":{},"conflicts":[]},"archives":[],"assets":[]}`)
	workspace.Set("localMigration", copy)
	migrationTestSeal(t, workspace)
	return workspace
}

func migrationTestAsset(t *testing.T, id string) *contracts.Object {
	t.Helper()
	return migrationTestObject(t, `{"assetId":"sha256:`+strings.Repeat(id, 64)+`","metadata":{"mediaType":"application/octet-stream","byteLength":3}}`)
}

func TestLocalMigrationHistoricalAssetsAndOrderedExtensions(t *testing.T) {
	workspace := migrationTestWorkspace(t)
	copy := workspace.Child("localMigration")
	history, recovery, archived, audit := migrationTestAsset(t, "1"), migrationTestAsset(t, "2"), migrationTestAsset(t, "3"), migrationTestAsset(t, "4")
	copy.Set("history", []any{migrationTestObject(t, `{"documentId":"orphan","snapshots":[]}`)})
	copy.Array("history")[0].(*contracts.Object).Set("snapshots", []any{history})
	snapshot := migrationTestObject(t, `{"id":"recovery","savedAt":1,"baseRevision":null,"workspace":{"documents":[]}}`)
	snapshot.Child("workspace").Set("extension", recovery)
	copy.Set("recovery", []any{snapshot})
	nested := migrationTestWorkspace(t).Child("localMigration")
	// A nested archive's retained asset index itself protects originals. Only
	// the outer index is excluded when finding the complete reference union.
	nested.Set("assets", []any{archived})
	copy.Set("archives", []any{nested})
	copy.Child("sourceAudit").Set("audit", []any{audit})
	copy.Set("assets", []any{audit, history, archived, recovery})
	workspace.Set("extension", migrationTestObject(t, `{"z":"\ud800","2":-0,"10":1e21,"a":1e-7,"𐀀":"中文🙂","￿":true}`))
	raw := migrationTestSeal(t, workspace)
	formatted, result, assets, err := WorkspaceJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(assets) != 4 || assets[0].AssetID != history.String("assetId") || assets[3].AssetID != audit.String("assetId") {
		t.Fatalf("historical union not sorted/complete: %#v", assets)
	}
	if !bytes.Contains(formatted, []byte(`\ud800`)) {
		t.Fatal("isolated UTF-16 extension was not preserved")
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := WorkspaceJSON(encoded); err != nil {
		t.Fatalf("bridge JSON broke canonical checksums: %v", err)
	}
	if _, _, _, err := WorkspaceJSON(formatted); err != nil {
		t.Fatalf("formatted archive failed revalidation: %v", err)
	}
}

func TestLocalMigrationHashTextAndPrivateConfigurationAreNotAssets(t *testing.T) {
	workspace := migrationTestWorkspace(t)
	hashText := "sha256:" + strings.Repeat("a", 64)
	document := workspace.Array("documents")[0].(*contracts.Object)
	document.Array("nodes")[0].(*contracts.Object).Set("text", hashText)
	workspace.Child("extension").Set(hashText, "ordinary user text")
	copy := workspace.Child("localMigration")
	copy.Child("source").Set("futureProvenance", migrationTestAsset(t, "e"))
	copy.Set("preferences", migrationTestObject(t, `{"ai":{"model":"fixture"}}`))
	copy.Set("credentials", migrationTestObject(t, `{"aiApiKey":"fixture"}`))
	_, _, assets, err := WorkspaceJSON(migrationTestSeal(t, workspace))
	if err != nil {
		t.Fatal(err)
	}
	if len(assets) != 0 {
		t.Fatal("ordinary text or private configuration became an attachment")
	}
}

func TestLocalMigrationShapeAndClosureRejections(t *testing.T) {
	tests := map[string]func(*contracts.Object){
		"null-copy":           func(workspace *contracts.Object) { workspace.Set("localMigration", nil) },
		"unsupported-version": func(workspace *contracts.Object) { workspace.Child("localMigration").Set("version", float64(2)) },
		"missing-actor":       func(workspace *contracts.Object) { workspace.Child("localMigration").Child("source").Delete("actorId") },
		"unsafe-revision": func(workspace *contracts.Object) {
			workspace.Child("localMigration").Child("source").Set("revision", float64(9007199254740992))
		},
		"missing-history":  func(workspace *contracts.Object) { workspace.Child("localMigration").Delete("history") },
		"missing-pre-copy": func(workspace *contracts.Object) { workspace.Child("localMigration").Delete("preAttachment") },
		"invalid-date":     func(workspace *contracts.Object) { workspace.Child("localMigration").Set("createdAt", "invalid") },
		"duplicate-history": func(workspace *contracts.Object) {
			row := migrationTestObject(t, `{"documentId":"doc","snapshots":[]}`)
			workspace.Child("localMigration").Set("history", []any{row, row})
		},
		"duplicate-recovery": func(workspace *contracts.Object) {
			row := migrationTestObject(t, `{"id":"same","workspace":{"documents":[]},"savedAt":1,"baseRevision":null}`)
			workspace.Child("localMigration").Set("recovery", []any{row, row})
		},
		"invalid-recovery-file": func(workspace *contracts.Object) {
			workspace.Child("localMigration").Set("recoveryFiles", []any{migrationTestObject(t, `{"id":"file","content":null}`)})
		},
		"nested-shape": func(workspace *contracts.Object) {
			workspace.Child("localMigration").Set("archives", []any{contracts.NewObject()})
		},
		"pre-copy-document-array": func(workspace *contracts.Object) {
			workspace.Child("localMigration").Set("preOperation", migrationTestObject(t, `{"documents":{}}`))
		},
		"unknown-preference": func(workspace *contracts.Object) {
			workspace.Child("localMigration").Set("preferences", migrationTestObject(t, `{"sync":{}}`))
		},
		"unknown-ai-preference": func(workspace *contracts.Object) {
			workspace.Child("localMigration").Set("preferences", migrationTestObject(t, `{"ai":{"apiKey":"private"}}`))
		},
		"null-preference": func(workspace *contracts.Object) { workspace.Child("localMigration").Set("preferences", nil) },
		"unknown-credentials": func(workspace *contracts.Object) {
			workspace.Child("localMigration").Set("credentials", migrationTestObject(t, `{"aiApiKey":"key","token":"token"}`))
		},
		"executable-audit": func(workspace *contracts.Object) {
			workspace.Child("localMigration").Child("sourceAudit").Set("cursor", float64(1))
		},
		"index-not-reference": func(workspace *contracts.Object) {
			workspace.Child("localMigration").Set("assets", []any{migrationTestAsset(t, "1")})
		},
		"missing-historical-asset": func(workspace *contracts.Object) {
			row := migrationTestObject(t, `{"documentId":"doc","snapshots":[]}`)
			row.Set("snapshots", []any{migrationTestAsset(t, "1")})
			workspace.Child("localMigration").Set("history", []any{row})
		},
		"duplicate-index": func(workspace *contracts.Object) {
			asset := migrationTestAsset(t, "1")
			workspace.Child("localMigration").Set("assets", []any{asset, asset})
		},
		"metadata-collision": func(workspace *contracts.Object) {
			asset, other := migrationTestAsset(t, "1"), migrationTestAsset(t, "1")
			other.Child("metadata").Set("byteLength", float64(4))
			workspace.Child("localMigration").Child("sourceAudit").Set("audit", []any{asset, other})
			workspace.Child("localMigration").Set("assets", []any{asset})
		},
		"null-optional-dimension": func(workspace *contracts.Object) {
			asset := migrationTestAsset(t, "1")
			asset.Child("metadata").Set("width", nil)
			workspace.Child("localMigration").Set("assets", []any{asset})
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			workspace := migrationTestWorkspace(t)
			mutate(workspace)
			var raw []byte
			if workspace.Child("localMigration") == nil {
				raw, _ = contracts.Stringify(workspace, false, false)
			} else {
				raw = migrationTestSeal(t, workspace)
			}
			if _, _, _, err := WorkspaceJSON(raw); err == nil {
				t.Fatal("malformed complete copy was accepted")
			}
		})
	}
}

func TestLocalMigrationSourceAndContentChecksums(t *testing.T) {
	for _, name := range []string{"source", "content", "missing-content"} {
		t.Run(name, func(t *testing.T) {
			workspace := migrationTestWorkspace(t)
			switch name {
			case "source":
				workspace.Set("extension", "tampered body")
			case "content":
				workspace.Child("localMigration").Set("extension", "tampered archive")
			case "missing-content":
				workspace.Child("localMigration").Delete("contentSha256")
			}
			raw, _ := contracts.Stringify(workspace, false, false)
			if _, _, _, err := WorkspaceJSON(raw); err == nil {
				t.Fatal("checksum violation was accepted")
			}
		})
	}
}

func TestLocalMigrationNestedAndRecoveryBudgets(t *testing.T) {
	workspace := migrationTestWorkspace(t)
	copy := workspace.Child("localMigration")
	for depth := 0; depth < 17; depth++ {
		nested := migrationTestWorkspace(t).Child("localMigration")
		copy.Set("archives", []any{nested})
		copy = nested
	}
	if _, _, _, err := WorkspaceJSON(migrationTestSeal(t, workspace)); err == nil {
		t.Fatal("nested archive depth budget was bypassed")
	}
	workspace = migrationTestWorkspace(t)
	node := contracts.NewObject()
	root := node
	for depth := 0; depth < contracts.Limits.DesktopDepth; depth++ {
		child := contracts.NewObject()
		node.Set("children", []any{child})
		node = child
	}
	backup := migrationTestObject(t, `{"documents":[{"nodes":[]}]}`)
	backup.Array("documents")[0].(*contracts.Object).Set("nodes", []any{root})
	workspace.Child("localMigration").Set("preOperation", backup)
	if _, _, _, err := WorkspaceJSON(migrationTestSeal(t, workspace)); err == nil {
		t.Fatal("historical workspace tree depth budget was bypassed")
	}
}
