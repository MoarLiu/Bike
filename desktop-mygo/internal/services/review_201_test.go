package services

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestAssetBatchesBoundCountAndBytesWithoutLosingObjects(t *testing.T) {
	for _, fixture := range []struct {
		count    int
		size     int64
		expected int
	}{{1001, 1, 2}, {5, 128 * 1024 * 1024, 2}} {
		assets := []Asset{}
		for index := 0; index < fixture.count; index++ {
			assets = append(assets, Asset{AssetID: fmt.Sprintf("sha256:%064x", index), Metadata: Metadata{MediaType: "application/octet-stream", ByteLength: fixture.size}})
		}
		batches, total, err := AssetBatches(assets)
		if err != nil || len(batches) != fixture.expected || total != fixture.count {
			t.Fatalf("bad batching %d %d %v", len(batches), total, err)
		}
		received := 0
		for _, batch := range batches {
			var bytes int64
			for _, asset := range batch {
				bytes += asset.Metadata.ByteLength
				received++
			}
			if len(batch) > 1000 || bytes > 512*1024*1024 {
				t.Fatal("batch exceeded limits")
			}
		}
		if received != fixture.count {
			t.Fatal("objects dropped")
		}
	}
}

func TestSyncOrderingNegotiationRemainsWithinRouteAllowlist(t *testing.T) {
	for _, fixture := range []struct{ path, method string }{
		{"/api/v2/status", "GET"}, {"/api/v2/enable", "POST"}, {"/api/v2/operations", "POST"},
		{"/api/v2/operation-chunks/large%2Fedit/0", "GET"}, {"/api/v2/receipts/id", "GET"},
	} {
		target, method, err := SyncURL(map[string]any{"serverUrl": "https://fixture.invalid/prefix", "pathname": fixture.path + "?bikeOrdering=2", "method": fixture.method})
		if err != nil || target != "https://fixture.invalid/prefix"+fixture.path+"?bikeOrdering=2" || method != fixture.method {
			t.Fatalf("%s %s %v", target, method, err)
		}
	}
	for _, path := range []string{"/api/v2/status?bikeOrdering=3", "/api/v2/status?after=1", "/api/v2/status?redirect=https://outside.invalid", "/api/documents/a?bikeOrdering=2"} {
		if _, _, err := SyncURL(map[string]any{"serverUrl": "https://fixture.invalid", "pathname": path}); err == nil {
			t.Fatalf("unsafe query accepted: %s", path)
		}
	}
}

func TestNetworkKeepsRawJSONCodeUnitsAndBoundsTextErrors(t *testing.T) {
	raw := []byte(`{"text":"\ud800","low":"\udc00","emoji":"🙂"}`)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/error" {
			writer.WriteHeader(502)
			writer.Write(bytes.Repeat([]byte("x"), 1000))
			return
		}
		body, _ := io.ReadAll(request.Body)
		if !bytes.Equal(body, raw) {
			t.Errorf("outgoing JSON changed: %s", body)
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.Write(raw)
	}))
	defer server.Close()
	network := NewNetwork()
	result, err := network.json(context.Background(), server.URL, "POST", "", json.RawMessage(raw), time.Second, 4096, true, true)
	if err != nil || !bytes.Equal(result["data"].(json.RawMessage), raw) {
		t.Fatalf("incoming JSON changed: %v %v", result, err)
	}
	result, err = network.json(context.Background(), server.URL+"/error", "GET", "", nil, time.Second, 4096, true, true)
	if err != nil || len(result["data"].(map[string]any)["message"].(string)) != 500 {
		t.Fatalf("unbounded error: %v %v", result, err)
	}
}

func TestArchiveDirectoryBudgetPrecedesZipAllocation(t *testing.T) {
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	entry, _ := writer.Create("workspace.json")
	entry.Write([]byte(`{}`))
	writer.Close()
	raw := output.Bytes()
	if err := preflightArchive(bytes.NewReader(raw), int64(len(raw))); err != nil {
		t.Fatal(err)
	}
	tampered := append([]byte{}, raw...)
	binary.LittleEndian.PutUint16(tampered[len(tampered)-12:], 10001)
	if preflightArchive(bytes.NewReader(tampered), int64(len(tampered))) == nil {
		t.Fatal("entry count accepted")
	}
	// A forged small count must not bypass the actual central-directory walk.
	binary.LittleEndian.PutUint16(tampered[len(tampered)-12:], 0)
	binary.LittleEndian.PutUint16(tampered[len(tampered)-14:], 0)
	if preflightArchive(bytes.NewReader(tampered), int64(len(tampered))) == nil {
		t.Fatal("forged directory count accepted")
	}
}
