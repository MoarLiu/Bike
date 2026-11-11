package mcp

import (
	"encoding/json"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"os"
	"testing"
)

func TestWorkspaceNormalizationMatchesJavaScript(t *testing.T) {
	raw, err := os.ReadFile("../../tests/fixtures/workspace-normalization.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Raw        string `json:"raw"`
		Normalized string `json:"normalized"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for index, fixture := range cases {
		value, err := contracts.ParseJSON([]byte(fixture.Raw))
		if err != nil {
			t.Fatal(err)
		}
		normalized, err := normalizeWorkspace(asObject(value))
		if err != nil {
			t.Fatal(err)
		}
		actual, err := contracts.Stringify(normalized, true, false)
		if err != nil || string(actual) != fixture.Normalized {
			t.Fatalf("normalization %d differs\nactual %s\nexpected %s\nerror %v", index, actual, fixture.Normalized, err)
		}
	}
}

func TestWorkspaceNormalizationUsesJavaScriptWhitespace(t *testing.T) {
	const at = "2026-11-11T00:00:00.000Z"
	for _, fixture := range []struct {
		name       string
		padding    string
		retained   string
		markdownAt string
	}{
		{name: "NEL remains content", padding: "\u0085", retained: "\u0085", markdownAt: "\u0085"},
		{name: "BOM is trimmed", padding: "\ufeff", markdownAt: at},
		{name: "JavaScript spaces are trimmed", padding: "\u00a0\u2028\u2029\u3000", markdownAt: at},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			document := ordered("id", fixture.padding+"doc"+fixture.padding,
				"title", fixture.padding+"Title"+fixture.padding, "updatedAt", at,
				"markdownSource", "# Title", "markdownUpdatedAt", fixture.padding,
				"nodes", []any{ordered("id", fixture.padding+"root"+fixture.padding,
					"text", "Root", "codeLanguage", fixture.padding+"go"+fixture.padding, "children", []any{})})
			withoutSource := ordered("id", "no-source", "nodes", []any{}, "markdownUpdatedAt", fixture.padding)
			workspace, err := normalizeWorkspace(ordered("version", float64(1), "documents", []any{document, withoutSource}))
			if err != nil {
				t.Fatal(err)
			}
			expectedID := fixture.retained + "doc" + fixture.retained
			if document.String("id") != expectedID || workspace.String("activeDocumentId") != expectedID {
				t.Fatalf("document identity differs from JavaScript: %q", document.String("id"))
			}
			if document.String("title") != fixture.retained+"Title"+fixture.retained ||
				document.String("markdownUpdatedAt") != fixture.markdownAt {
				t.Fatalf("document fields differ from JavaScript: title=%q markdownUpdatedAt=%q",
					document.String("title"), document.String("markdownUpdatedAt"))
			}
			node := asObject(document.Array("nodes")[0])
			if node.String("id") != fixture.retained+"root"+fixture.retained ||
				node.String("codeLanguage") != fixture.retained+"go"+fixture.retained {
				t.Fatalf("node fields differ from JavaScript: id=%q language=%q", node.String("id"), node.String("codeLanguage"))
			}
			if withoutSource.Has("markdownUpdatedAt") != (fixture.retained != "") {
				t.Fatal("blank Markdown timestamp without a source differs from JavaScript")
			}
		})
	}

	for _, fixture := range []struct {
		name string
		id   string
		ok   bool
	}{
		{name: "NEL trash identity remains valid", id: "\u0085", ok: true},
		{name: "BOM trash identity is blank", id: "\ufeff"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			workspace := ordered("version", float64(1),
				"documents", []any{ordered("id", "doc", "title", "Title", "nodes", []any{})},
				"trash", []any{ordered("id", "trash", "deletedAt", at, "document",
					ordered("id", fixture.id, "title", "Trash", "nodes", []any{}))})
			_, err := normalizeWorkspace(workspace)
			if (err == nil) != fixture.ok {
				t.Fatalf("trash identity validity differs from JavaScript: %q, %v", fixture.id, err)
			}
		})
	}
}
