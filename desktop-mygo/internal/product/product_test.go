package product

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestPreviewIsolation(t *testing.T) {
	info, err := Current()
	if err != nil {
		t.Fatal(err)
	}
	if info.Identifier != "com.bike.mygo.preview" || info.Profile != "Bike-MyGO-preview" || info.TagPrefix != "mygo-v" || info.Version != "2.0.0" {
		t.Fatalf("identity drift: %+v", info)
	}
	if info.TargetMinimumSystemVersion != "12.0" || info.MinimumSystemVersion != "12.0" || info.GoExperiment != "jsonv2" || info.MyGOCompatibilityPatch != "go126-jsonv2-compatibility-1" {
		t.Fatal("the macOS 12 compatibility build must retain its explicit toolchain patch")
	}
	if strings.Contains(info.DiscoveryPath("/test"), filepath.Join("Support", "bike")) {
		t.Fatal("Electron discovery selected")
	}
}
