package sourceexport

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/services"
)

func TestProfileCloneDoesNotShareFiles(t *testing.T) {
	source := t.TempDir()
	name := filepath.Join(source, "IndexedDB", "example")
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(name, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := fingerprint(context.Background(), source, false)
	if err != nil {
		t.Fatal(err)
	}
	clone := filepath.Join(t.TempDir(), "clone")
	if err := copyTree(context.Background(), source, clone, false); err != nil {
		t.Fatal(err)
	}
	sourceInfo, _ := os.Stat(name)
	cloneName := filepath.Join(clone, "IndexedDB", "example")
	cloneInfo, _ := os.Stat(cloneName)
	if os.SameFile(sourceInfo, cloneInfo) {
		t.Fatal("profile clone shares the original inode")
	}
	if err := os.WriteFile(cloneName, []byte("changed clone"), 0600); err != nil {
		t.Fatal(err)
	}
	after, err := fingerprint(context.Background(), source, false)
	if err != nil || before != after {
		t.Fatalf("source changed: %v", err)
	}
}

func TestProfileLocksAndSymlinksRefused(t *testing.T) {
	source := t.TempDir()
	lock := filepath.Join(source, "SingletonLock")
	if err := os.Symlink("host-12345", lock); err != nil {
		t.Fatal(err)
	}
	if closedProfile(source) == nil {
		t.Fatal("dangling singleton lock was accepted")
	}
	if err := os.Remove(lock); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(source, "external")); err != nil {
		t.Fatal(err)
	}
	if _, err := fingerprint(context.Background(), source, false); err == nil {
		t.Fatal("profile symlink was accepted")
	}
}

func TestRuntimeCopyExcludesOriginalApplicationCode(t *testing.T) {
	source := t.TempDir()
	resources := filepath.Join(source, "Contents", "Resources")
	if err := os.MkdirAll(filepath.Join(resources, "app"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"app.asar", "app-update.yml", "app/main.cjs", "runtime.bin"} {
		if err := os.WriteFile(filepath.Join(resources, name), []byte("original"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	target := filepath.Join(t.TempDir(), "copy")
	if err := copyTree(context.Background(), source, target, true); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"app.asar", "app-update.yml", "app"} {
		if _, err := os.Lstat(filepath.Join(target, "Contents", "Resources", name)); !os.IsNotExist(err) {
			t.Fatalf("original app resource copied: %s", name)
		}
	}
	if _, err := os.Stat(filepath.Join(target, "Contents", "Resources", "runtime.bin")); err != nil {
		t.Fatal(err)
	}
}

func TestCanceledFingerprintAndClone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := fingerprint(ctx, t.TempDir(), false); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if err := copyTree(ctx, t.TempDir(), filepath.Join(t.TempDir(), "copy"), false); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected cancellation, got %v", err)
	}
}

func TestDestinationCannotWriteSource(t *testing.T) {
	app, profile := t.TempDir(), t.TempDir()
	for _, output := range []string{filepath.Join(profile, "export.zip"), filepath.Join(app, "export.zip")} {
		if _, _, _, err := validatePaths(Options{ElectronApp: app, SourceProfile: profile, Output: output}); err == nil {
			t.Fatal("accepted a destination inside the source")
		}
	}
}

func TestDiskFailurePreservesExistingDestination(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "existing.zip")
	if err := os.WriteFile(filename, []byte("existing"), 0600); err != nil {
		t.Fatal(err)
	}
	err := services.AtomicFile(context.Background(), filename, func(destination io.Writer) error {
		if _, err := copyContext(context.Background(), fullDiskWriter{destination}, strings.NewReader("partial archive")); err != nil {
			return err
		}
		t.Fatal("disk error was swallowed")
		return nil
	})
	if !errors.Is(err, syscall.ENOSPC) {
		t.Fatalf("expected ENOSPC, got %v", err)
	}
	value, _ := os.ReadFile(filename)
	if string(value) != "existing" {
		t.Fatal("failed archive installation replaced the destination")
	}
	entries, _ := os.ReadDir(filepath.Dir(filename))
	if len(entries) != 1 {
		t.Fatal("failed archive installation leaked a temporary file")
	}
}

type fullDiskWriter struct{ writer io.Writer }

func (writer fullDiskWriter) Write(buffer []byte) (int, error) {
	count, err := writer.writer.Write(buffer[:min(4, len(buffer))])
	if err != nil {
		return count, err
	}
	return count, syscall.ENOSPC
}
