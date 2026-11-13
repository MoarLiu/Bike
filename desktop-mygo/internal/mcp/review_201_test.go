package mcp

import (
	"encoding/json"
	"fmt"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"os"
	"strings"
	"testing"
	"time"
)

func TestMarkdownSourceOwnershipVectors(t *testing.T) {
	raw, err := os.ReadFile("../../tests/fixtures/markdown-anchors.json")
	if err != nil {
		t.Fatal(err)
	}
	value, err := contracts.ParseJSON(raw)
	if err != nil {
		t.Fatal(err)
	}
	for index, row := range value.([]any) {
		fixture := asObject(row)
		actual, err := contracts.Stringify(anchorKnowledge(fixture.Child("document")), false, true)
		expected, _ := contracts.Stringify(fixture.Child("expected"), false, true)
		if err != nil || string(actual) != string(expected) {
			t.Fatalf("source case %d:\nactual %s\nexpected %s\n%v", index, actual, expected, err)
		}
		workspace := fixture.Child("workspace")
		actual, err = contracts.Stringify(knowledgeSummary(workspace, asObject(workspace.Array("documents")[0])), false, true)
		expected, _ = contracts.Stringify(fixture.Child("connections"), false, true)
		if err != nil || string(actual) != string(expected) {
			t.Fatalf("connections case %d:\nactual %s\nexpected %s\n%v", index, actual, expected, err)
		}
	}
}

func TestBreadcrumbAndWireArraysRetainIsolatedSurrogates(t *testing.T) {
	parsed, err := contracts.ParseJSON([]byte(`{"title":"\ud800","nodes":[{"id":"n","text":"\udc00","children":[]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	document := asObject(parsed)
	result := nodeFields(document, asObject(document.Array("nodes")[0]), []int{0}, nil)
	raw, err := contracts.Stringify(result, false, false)
	if err != nil || !strings.Contains(string(raw), `"breadcrumb":["\ud800","\udc00"]`) {
		t.Fatalf("%s %v", raw, err)
	}
	wire := &wireResult{body: map[string]any{"completion": map[string]any{"values": []string{document.String("title")}}}}
	raw, err = json.Marshal(wire)
	if err != nil || !strings.Contains(string(raw), `\ud800`) {
		t.Fatalf("%s %v", raw, err)
	}
}

func TestLegacyDocumentDatesRemainReadable(t *testing.T) {
	for _, value := range []string{"2026/11/13", "11/13/2026", "November 13, 2026", "Fri, 13 Nov 2026 08:00:00 GMT", "2026-11-13"} {
		if !validDate(value) {
			t.Fatalf("legacy timestamp rejected: %s", value)
		}
	}
	if validDate("not a date") {
		t.Fatal("invalid timestamp accepted")
	}
}

func TestLegacyDateTimezoneMatchesJavaScript(t *testing.T) {
	location := time.FixedZone("Asia/Shanghai", 8*3600)
	for _, fixture := range []struct {
		value        string
		milliseconds int64
	}{
		{"2026-11-13", 1794528000000},
		{"2026/11/13", 1794499200000},
		{"2026-11-13T08:00:00", 1794528000000},
		{"November 13, 2026", 1794499200000},
		{"Fri Nov 13 2026 08:00:00 GMT+0800 (China Standard Time)", 1794528000000},
		{"Fri, 13 Nov 2026 08:00:00 PST", 1794585600000},
	} {
		at, ok := parseDocumentDateInLocation(fixture.value, location)
		if !ok || at.UnixMilli() != fixture.milliseconds {
			t.Fatalf("%s: %v %v", fixture.value, at, ok)
		}
	}
}

func TestNormalizationDuplicateIdentitiesTrashAndDepth(t *testing.T) {
	at := "2026-11-13T00:00:00.000Z"
	makeDocument := func() *object {
		return ordered("id", "doc", "title", "Title", "createdAt", at, "updatedAt", at, "nodes", []any{ordered("id", "dup", "text", "first", "children", []any{}), ordered("id", "dup", "text", "second", "children", []any{})})
	}
	workspace, err := normalizeWorkspace(ordered("version", float64(3), "documents", []any{makeDocument(), makeDocument()}, "trash", []any{ordered("id", "trash", "deletedAt", at, "document", makeDocument())}))
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	add := func(id string) {
		if id == "" || ids[id] {
			t.Fatalf("duplicate normalized identity %s", id)
		}
		ids[id] = true
	}
	for _, raw := range workspace.Array("documents") {
		document := asObject(raw)
		add(document.String("id"))
		walkNodes(document.Array("nodes"), func(node *object, _ []int, _ []*object) { add(node.String("id")) })
	}
	if asObject(workspace.Array("trash")[0]).Child("document").String("id") != "doc" {
		t.Fatal("trash identity was rewritten against live documents")
	}
	for _, depth := range []int{256, 257} {
		node := ordered("id", "leaf", "text", "leaf", "children", []any{})
		for index := 1; index < depth; index++ {
			node = ordered("id", fmt.Sprint(index), "text", "parent", "children", []any{node})
		}
		_, err := normalizeWorkspace(ordered("version", float64(3), "documents", []any{ordered("id", "deep", "title", "Deep", "nodes", []any{node})}))
		if (err == nil) != (depth == 256) {
			t.Fatalf("depth %d: %v", depth, err)
		}
	}
}
