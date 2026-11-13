package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type catalog struct {
	Tools             []*mcp.Tool             `json:"tools"`
	Resources         []*mcp.Resource         `json:"resources"`
	ResourceTemplates []*mcp.ResourceTemplate `json:"resourceTemplates"`
	Prompts           []*mcp.Prompt           `json:"prompts"`
	Templates         map[string]struct {
		Instruction string `json:"instruction"`
	} `json:"templates"`
}

// The pinned SDK predates execution.taskSupport and materializes annotation
// defaults. Preserve the frozen wire catalog while using its native handlers.
type wireResult struct {
	mcp.Result
	body any
}

func (result *wireResult) MarshalJSON() ([]byte, error) {
	return contracts.Stringify(result.body, false, false)
}

var readTools = map[string]bool{"get_workspace_summary": true, "list_documents": true, "search_outline": true, "get_document": true, "get_node": true, "export_document": true}

type mutationStore interface {
	Mutate(context.Context, string, *object) (*object, error)
}
type proposalStore interface {
	Status(context.Context, string) (*object, error)
}

func redactedToolError(store Store, err error) error {
	file, ok := store.(FileStore)
	if !ok {
		return err
	}
	absolute, absoluteErr := filepath.Abs(file.Path)
	if absoluteErr != nil {
		absolute = file.Path
	}
	message := err.Error()
	for _, path := range []string{absolute, file.Path, filepath.Dir(absolute)} {
		if len(path) > 1 {
			message = strings.ReplaceAll(message, path, "[工作区路径]")
		}
	}
	return fmt.Errorf("%s", message)
}

func readTool(snapshot Snapshot, name string, args *object) (any, error) {
	if name == "get_workspace_summary" {
		return summary(snapshot)
	}
	workspace, err := snapshotWorkspace(snapshot)
	if err != nil {
		return nil, err
	}
	switch name {
	case "list_documents":
		return listDocuments(workspace, args), nil
	case "search_outline":
		return searchOutline(workspace, args, snapshot.Live)
	case "get_document":
		return getDocument(workspace, args, snapshot.Live)
	case "get_node":
		return getNode(workspace, args, snapshot.Live)
	case "export_document":
		if !snapshot.Live {
			document, err := documentByID(workspace, args.String("documentId"))
			if err != nil {
				return nil, err
			}
			if treeCount(document.Array("nodes")) > 2000 {
				return nil, fmt.Errorf("主题数超过 2,000，请缩小读取范围")
			}
		}
		return exportDocument(workspace, args)
	default:
		return nil, fmt.Errorf("未知读取工具")
	}
}
func parsedArguments(request *mcp.CallToolRequest, _ map[string]json.RawMessage, tool *mcp.Tool) (*object, error) {
	raw := request.Params.Arguments
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	if len(raw) > contracts.Limits.OperationBytes {
		return nil, &jsonrpc.Error{Code: -32602, Message: "请求超过 4 MiB 处理预算"}
	}
	value, err := contracts.ParseJSON(raw)
	if err != nil {
		return nil, err
	}
	args := asObject(value)
	if args == nil {
		return nil, fmt.Errorf("工具参数需要为对象")
	}
	schema, _ := tool.InputSchema.(map[string]any)
	if err := normalizeArguments(args, schema, "arguments"); err != nil {
		return nil, &jsonrpc.Error{Code: -32602, Message: err.Error()}
	}
	var nodes []any
	switch tool.Name {
	case "create_document":
		nodes = args.Array("initialNodes")
	case "create_node", "append_children":
		nodes = args.Array("children")
	}
	nodes = append([]any{}, nodes...)
	for len(nodes) > 0 {
		node := asObject(nodes[len(nodes)-1])
		nodes = nodes[:len(nodes)-1]
		if node == nil {
			return nil, &jsonrpc.Error{Code: -32602, Message: "子主题必须是对象"}
		}
		for field, maximum := range map[string]int{"text": 10000, "note": 50000, "codeBlock": 50000, "codeLanguage": 80} {
			if node.Has(field) {
				value, ok := node.Get(field).(string)
				if !ok || contracts.UTF16Length(value) > maximum {
					return nil, &jsonrpc.Error{Code: -32602, Message: "子主题 " + field + " 类型无效或超过长度预算"}
				}
			}
		}
		if node.Has("children") && node.Array("children") == nil {
			return nil, &jsonrpc.Error{Code: -32602, Message: "子主题 children 必须是数组"}
		}
		nodes = append(nodes, node.Array("children")...)
	}
	return args, nil
}

func normalizeArguments(value any, schema map[string]any, path string) error {
	if text, ok := value.(string); ok {
		length := contracts.UTF16Length(text)
		if maximum, ok := schema["maxLength"].(float64); ok && length > int(maximum) {
			return fmt.Errorf("%s 超过字符串长度预算", path)
		}
		if minimum, ok := schema["minLength"].(float64); ok && length < int(minimum) {
			return fmt.Errorf("%s 字符串长度不足", path)
		}
	}
	if list, ok := value.([]any); ok {
		if items, ok := schema["items"].(map[string]any); ok {
			for index, item := range list {
				if err := normalizeArguments(item, items, fmt.Sprintf("%s[%d]", path, index)); err != nil {
					return err
				}
			}
		}
	}
	if object := asObject(value); object != nil {
		if properties, ok := schema["properties"].(map[string]any); ok {
			for _, key := range append([]string{}, object.Keys...) {
				if _, allowed := properties[key]; !allowed {
					object.Delete(key)
				}
			}
			for key, raw := range properties {
				property, _ := raw.(map[string]any)
				if fallback, ok := property["default"]; ok && !object.Has(key) {
					copy, err := contracts.Clone(fallback)
					if err != nil {
						return err
					}
					object.Set(key, copy)
				}
				if object.Has(key) {
					if err := normalizeArguments(object.Get(key), property, path+"."+key); err != nil {
						return err
					}
				}
			}
		}
	}
	return nil
}
func toolResult(value any) (*mcp.CallToolResult, error) {
	encoded, err := contracts.Stringify(value, true, false)
	if err != nil {
		return nil, err
	}
	if len(encoded) > 8*1024*1024 {
		return nil, fmt.Errorf("工具结果超过 8 MiB，请缩小读取范围")
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(encoded)}}, StructuredContent: json.RawMessage(encoded)}, nil
}
func Run(ctx context.Context, store Store, info product.Info) error {
	server, err := newServer(store, info)
	if err != nil {
		return err
	}
	return server.Run(ctx, &mcp.StdioTransport{})
}

func newServer(store Store, info product.Info) (*mcp.Server, error) {
	var definitions catalog
	if err := json.Unmarshal(contracts.MCPCatalog, &definitions); err != nil {
		return nil, err
	}
	var wireCatalog struct {
		Tools             []json.RawMessage `json:"tools"`
		ResourceTemplates []json.RawMessage `json:"resourceTemplates"`
		Prompts           []json.RawMessage `json:"prompts"`
	}
	if err := json.Unmarshal(contracts.MCPCatalog, &wireCatalog); err != nil {
		return nil, err
	}
	wireTools := []json.RawMessage{}
	for index, tool := range definitions.Tools {
		if tool.Name == "get_proposal_status" {
			if _, ok := store.(proposalStore); !ok {
				continue
			}
		}
		wireTools = append(wireTools, wireCatalog.Tools[index])
	}
	server := mcp.NewServer(&mcp.Implementation{Name: "bike-mygo", Title: "Bike MyGO MCP", Version: info.Version}, &mcp.ServerOptions{CompletionHandler: func(ctx context.Context, request *mcp.CompleteRequest) (*mcp.CompleteResult, error) {
		return completeResource(ctx, store, definitions, request.Params)
	}, Capabilities: &mcp.ServerCapabilities{Tools: &mcp.ToolCapabilities{}, Resources: &mcp.ResourceCapabilities{}, Prompts: &mcp.PromptCapabilities{}}})
	server.AddReceivingMiddleware(func(next mcp.MethodHandler) mcp.MethodHandler {
		return func(ctx context.Context, method string, request mcp.Request) (mcp.Result, error) {
			if method == "resources/templates/list" {
				return &wireResult{Result: &mcp.ListResourceTemplatesResult{}, body: map[string]any{"resourceTemplates": wireCatalog.ResourceTemplates}}, nil
			}
			if method == "prompts/list" {
				return &wireResult{Result: &mcp.ListPromptsResult{}, body: map[string]any{"prompts": wireCatalog.Prompts}}, nil
			}
			if method == "tools/list" {
				return &wireResult{Result: &mcp.ListToolsResult{}, body: map[string]any{"tools": wireTools}}, nil
			}
			if method == "resources/list" {
				result, err := listResources(ctx, store, definitions.Resources)
				if err != nil {
					return nil, redactedToolError(store, err)
				}
				return result, nil
			}
			result, err := next(ctx, method, request)
			if method == "completion/complete" && err == nil {
				if completion, ok := result.(*mcp.CompleteResult); ok {
					details := map[string]any{"values": completion.Completion.Values, "hasMore": false}
					if resourceDocumentCompletion(request.(*mcp.CompleteRequest).Params) {
						details["total"] = len(completion.Completion.Values)
					}
					return &wireResult{Result: result, body: map[string]any{"completion": details}}, nil
				}
			}
			if method == "tools/call" && err == nil {
				if value, ok := result.(*mcp.CallToolResult); ok && value.IsError && len(value.Content) > 0 {
					if text, ok := value.Content[0].(*mcp.TextContent); ok && strings.HasPrefix(text.Text, `validating "arguments":`) {
						return nil, &jsonrpc.Error{Code: -32602, Message: text.Text}
					}
				}
			}
			// This client retains the existing Bike response envelope. The SDK's
			// zero-valued cache extensions are not part of the frozen contract.
			if err == nil && result != nil {
				raw, marshalErr := json.Marshal(result)
				if marshalErr != nil {
					return nil, marshalErr
				}
				var fields map[string]json.RawMessage
				if json.Unmarshal(raw, &fields) == nil {
					delete(fields, "ttlMs")
					delete(fields, "cacheScope")
					return &wireResult{Result: result, body: fields}, nil
				}
			}
			if err != nil {
				return result, redactedToolError(store, err)
			}
			return result, nil
		}
	})
	for _, resource := range definitions.Resources {
		server.AddResource(resource, func(ctx context.Context, request *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			return readResource(ctx, store, request.Params.URI)
		})
	}
	for _, template := range definitions.ResourceTemplates {
		server.AddResourceTemplate(template, func(ctx context.Context, request *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
			return readResource(ctx, store, request.Params.URI)
		})
	}
	for _, definition := range definitions.Prompts {
		prompt := definition
		server.AddPrompt(prompt, func(ctx context.Context, request *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
			return getPrompt(prompt.Name, request.Params.Arguments, definitions)
		})
	}
	for _, definition := range definitions.Tools {
		tool := definition
		if tool.Name == "get_proposal_status" {
			if _, ok := store.(proposalStore); !ok {
				continue
			}
		} else if !readTools[tool.Name] && !writeTools[tool.Name] {
			continue
		}
		mcp.AddTool(server, tool, func(ctx context.Context, request *mcp.CallToolRequest, validated map[string]json.RawMessage) (*mcp.CallToolResult, any, error) {
			args, err := parsedArguments(request, validated, tool)
			if err != nil {
				return nil, nil, err
			}
			var result any
			switch {
			case tool.Name == "get_proposal_status":
				result, err = store.(proposalStore).Status(ctx, args.String("requestId"))
			case writeTools[tool.Name]:
				mutator, ok := store.(mutationStore)
				if !ok {
					return nil, nil, fmt.Errorf("当前工作区不支持写入")
				}
				result, err = mutator.Mutate(ctx, tool.Name, args)
			default:
				var snapshot Snapshot
				snapshot, err = store.Load(ctx)
				if err == nil {
					result, err = readTool(snapshot, tool.Name, args)
				}
			}
			if err != nil {
				return nil, nil, redactedToolError(store, err)
			}
			response, err := toolResult(result)
			return response, nil, err
		})
	}
	return server, nil
}
