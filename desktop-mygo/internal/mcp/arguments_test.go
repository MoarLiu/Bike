package mcp

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	protocol "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestArgumentsMatchSchemaDefaultsAndUTF16(t *testing.T) {
	var definitions catalog
	if err := json.Unmarshal(contracts.MCPCatalog, &definitions); err != nil {
		t.Fatal(err)
	}
	var create *protocol.Tool
	for _, tool := range definitions.Tools {
		if tool.Name == "create_document" {
			create = tool
		}
	}
	if create == nil {
		t.Fatal("create tool missing")
	}
	request := &protocol.CallToolRequest{Params: &protocol.CallToolParamsRaw{Arguments: json.RawMessage(`{"title":"Title","expectedRevision":"rev","unknown":1,"initialNodes":[{"id":"root","text":"Root","unknown":1}]}`)}}
	args, err := parsedArguments(request, nil, create)
	if err != nil {
		t.Fatal(err)
	}
	if args.Has("unknown") || args.Get("dryRun") != true || args.Get("reason") != "" {
		t.Fatalf("wrong defaults %v", args)
	}
	node := asObject(args.Array("initialNodes")[0])
	if node.Has("unknown") || len(node.Array("children")) != 0 || !node.Has("children") {
		t.Fatal("nested schema differs")
	}
	node.Set("text", strings.Repeat("🙂", 5001))
	schema := create.InputSchema.(map[string]any)
	if err := normalizeArguments(args, schema, "arguments"); err == nil {
		t.Fatal("UTF16 budget bypassed")
	}
}
