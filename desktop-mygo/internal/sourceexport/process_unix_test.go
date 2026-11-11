//go:build darwin || linux

package sourceexport

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestCanceledHelperCleansOwnedProcessGroup(t *testing.T) {
	directory := t.TempDir()
	pidFile := filepath.Join(directory, "pid")
	script := filepath.Join(directory, "helper")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nsleep 60 &\necho $! > '"+pidFile+"'\nwait\n"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runHelper(ctx, script, "unused", directory) }()
	var child int
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		raw, err := os.ReadFile(pidFile)
		if err == nil {
			child, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
			if child > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if child <= 0 {
		t.Fatal("owned helper did not start")
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("canceled helper reported success")
	}
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if syscall.Kill(child, 0) != nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("owned helper child survived cancellation")
}
