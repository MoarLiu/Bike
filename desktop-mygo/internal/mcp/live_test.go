//go:build unix

package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLivePermissionsAndCancellation(t *testing.T) {
	// macOS Unix sockets have a short pathname limit, unlike Go's test temp paths.
	directory, err := os.MkdirTemp("", "mg-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(directory)
	socket := filepath.Join(directory, "s")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	file := filepath.Join(directory, "live-mcp.json")
	raw, _ := json.Marshal(map[string]any{"protocol": 2, "token": strings.Repeat("a", 64), "socketPath": socket})
	if err := os.WriteFile(file, raw, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenLive(context.Background(), file); err == nil {
		t.Fatal("public discovery accepted")
	}
	if err := os.Chmod(file, 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "link")
	if err := os.Symlink(file, link); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenLive(context.Background(), link); err == nil {
		t.Fatal("symlink discovery accepted")
	}
	store, err := OpenLive(context.Background(), file)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	connection, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	received := make(chan struct{})
	go func() {
		bufio.NewReader(connection).ReadString('\n')
		close(received)
	}()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() { _, err := store.Load(ctx); finished <- err }()
	select {
	case <-received:
	case <-time.After(2 * time.Second):
		t.Fatal("request not sent")
	}
	cancel()
	select {
	case err := <-finished:
		if err == nil {
			t.Fatal("canceled read succeeded")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled Live read hung")
	}
}
