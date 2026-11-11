package mcp

import (
	"bufio"
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

func TestFileRevisionUsesOriginalBytes(t *testing.T) {
	directory := t.TempDir()
	file := filepath.Join(directory, "workspace.json")
	raw := []byte(`{"version":3,"documents":[{"id":"doc","title":"fixture","createdAt":"2026-11-10T00:00:00.000Z","updatedAt":"2026-11-10T00:00:00.000Z","nodes":[]}]}`)
	if err := os.WriteFile(file, raw, 0600); err != nil {
		t.Fatal(err)
	}
	snapshot, err := (FileStore{Path: file}).Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf("%x", sha256.Sum256(raw))
	if snapshot.Revision != want || snapshot.Size != int64(len(raw)) || snapshot.Mode != "readonly" || snapshot.DisplayPath != "workspace.json" {
		t.Fatalf("unexpected snapshot %+v", snapshot)
	}
	actual, err := os.ReadFile(file)
	if err != nil || string(actual) != string(raw) {
		t.Fatal("File read modified its source")
	}
}

func TestFileBudgetAndCancellation(t *testing.T) {
	file, err := os.CreateTemp(t.TempDir(), "oversized-*")
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(int64(contracts.Limits.DocumentBytes) + 1); err != nil {
		t.Fatal(err)
	}
	file.Close()
	if _, err := (FileStore{Path: file.Name()}).Load(context.Background()); err == nil {
		t.Fatal("oversized workspace accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := (FileStore{Path: file.Name()}).Load(ctx); err != context.Canceled {
		t.Fatalf("cancellation lost: %v", err)
	}
}

func TestLegacyGeneratedIdentitiesRemainReadableWithinServer(t *testing.T) {
	file := filepath.Join(t.TempDir(), "legacy.json")
	if err := os.WriteFile(file, []byte(`{"documents":[{"title":"Legacy","nodes":[{"text":"Root"}]}]}`), 0600); err != nil {
		t.Fatal(err)
	}
	store := NewFileStore(file, "readonly")
	first, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.Load(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first.Ordered.String("activeDocumentId") != second.Ordered.String("activeDocumentId") {
		t.Fatal("generated document ID changed on every call")
	}
	if _, err := getDocument(second.Ordered, ordered("documentId", first.Ordered.String("activeDocumentId")), false); err != nil {
		t.Fatal(err)
	}
}

func TestLiveFramingRejectsTruncationAndOversize(t *testing.T) {
	for _, input := range []string{"no newline", strings.Repeat("x", 8192) + "\n"} {
		if _, err := readLine(bufio.NewReader(strings.NewReader(input)), 4096); err == nil {
			t.Fatal("invalid frame accepted")
		}
	}
	reader := bufio.NewReader(strings.NewReader("first\nsecond\n"))
	for _, want := range []string{"first\n", "second\n"} {
		line, err := readLine(reader, 4096)
		if err != nil || string(line) != want {
			t.Fatalf("frame boundary lost: %q %v", line, err)
		}
	}
}
