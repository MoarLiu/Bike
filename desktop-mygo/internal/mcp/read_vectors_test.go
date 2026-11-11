package mcp

import (
	"encoding/json"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"os"
	"testing"
)

func TestMarkdownAndKnowledgeReadVectors(t *testing.T) {
	raw, err := os.ReadFile("../../tests/fixtures/mcp-read-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Raw   string `json:"raw"`
		Calls []struct {
			Name     string          `json:"name"`
			Args     json.RawMessage `json:"args"`
			Expected json.RawMessage `json:"expected"`
		} `json:"calls"`
		Documents []struct {
			ID               string          `json:"id"`
			Markdown         string          `json:"markdown"`
			MetadataMarkdown string          `json:"metadataMarkdown"`
			Knowledge        json.RawMessage `json:"knowledge"`
		} `json:"documents"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for index, fixture := range cases {
		parsed, err := contracts.ParseJSON([]byte(fixture.Raw))
		if err != nil {
			t.Fatal(err)
		}
		workspace, err := normalizeWorkspace(asObject(parsed))
		if err != nil {
			t.Fatal(err)
		}
		for _, call := range fixture.Calls {
			parsedArgs, err := contracts.ParseJSON(call.Args)
			if err != nil {
				t.Fatal(err)
			}
			result, err := readTool(Snapshot{Ordered: workspace}, call.Name, asObject(parsedArgs))
			if err != nil {
				t.Fatal(err)
			}
			expected, err := contracts.ParseJSON(call.Expected)
			if err != nil {
				t.Fatal(err)
			}
			actual, _ := contracts.Stringify(result, false, true)
			wanted, _ := contracts.Stringify(expected, false, true)
			if string(actual) != string(wanted) {
				t.Fatalf("case %d tool %s differs\nactual %s\nexpected %s", index, call.Name, actual, wanted)
			}
		}
		for _, expected := range fixture.Documents {
			document, err := documentByID(workspace, expected.ID)
			if err != nil {
				t.Fatal(err)
			}
			actual, err := documentMarkdown(document, false)
			if err != nil || actual != expected.Markdown {
				t.Fatalf("case %d document %s Markdown mismatch\nactual %s\nexpected %s\nerror %v", index, expected.ID, actual, expected.Markdown, err)
			}
			actual, err = documentMarkdown(document, true)
			if err != nil || actual != expected.MetadataMarkdown {
				t.Fatalf("case %d document %s metadata mismatch\nactual %s\nexpected %s\nerror %v", index, expected.ID, actual, expected.MetadataMarkdown, err)
			}
			expectedKnowledge, err := contracts.ParseJSON(expected.Knowledge)
			if err != nil {
				t.Fatal(err)
			}
			want, _ := contracts.Stringify(expectedKnowledge, false, true)
			got, _ := contracts.Stringify(knowledgeSummary(workspace, document), false, true)
			if string(got) != string(want) {
				t.Fatalf("case %d knowledge mismatch\nactual %s\nexpected %s", index, got, want)
			}
		}
	}
}
func TestWikiScannerVectors(t *testing.T) {
	raw, err := os.ReadFile("../../tests/fixtures/wiki-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Text  string `json:"text"`
		Links []struct {
			Start        int     `json:"start"`
			End          int     `json:"end"`
			Raw          string  `json:"raw"`
			DocumentName string  `json:"documentName"`
			NodeName     *string `json:"nodeName"`
			Alias        *string `json:"alias"`
			Label        string  `json:"label"`
		} `json:"links"`
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range cases {
		actual := scanWiki(fixture.Text)
		if len(actual) != len(fixture.Links) {
			t.Fatalf("link count mismatch %q", fixture.Text)
		}
		for index, expected := range fixture.Links {
			got := actual[index]
			if got.start != expected.Start || got.end != expected.End || got.raw != expected.Raw || got.documentName != expected.DocumentName || got.label != expected.Label {
				t.Fatalf("wiki mismatch %q %+v %+v", fixture.Text, got, expected)
			}
		}
	}
}
