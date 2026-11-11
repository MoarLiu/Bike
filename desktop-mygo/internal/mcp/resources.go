package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/url"
	"strings"
)

func encodeComponent(value string) (string, error) {
	units := contracts.UTF16(value)
	for index := 0; index < len(units); index++ {
		unit := units[index]
		if unit >= 0xd800 && unit <= 0xdbff && index+1 < len(units) && units[index+1] >= 0xdc00 && units[index+1] <= 0xdfff {
			index++
			continue
		}
		if unit >= 0xd800 && unit <= 0xdfff {
			return "", fmt.Errorf("URI 包含无效 Unicode")
		}
	}
	var output strings.Builder
	for _, value := range []byte(value) {
		if value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' || strings.ContainsRune("-_.!~*'()", rune(value)) {
			output.WriteByte(value)
		} else {
			fmt.Fprintf(&output, "%%%02X", value)
		}
	}
	return output.String(), nil
}
func listResources(ctx context.Context, store Store, static []*mcp.Resource) (*mcp.ListResourcesResult, error) {
	snapshot, err := store.Load(ctx)
	if err != nil {
		return nil, err
	}
	workspace, err := snapshotWorkspace(snapshot)
	if err != nil {
		return nil, err
	}
	resources := append([]*mcp.Resource{}, static...)
	for _, markdown := range []bool{false, true} {
		for _, document := range liveDocuments(workspace) {
			id, err := encodeComponent(document.String("id"))
			if err != nil {
				return nil, err
			}
			uri := "bike://document/" + id
			name, title, mime, description := document.String("title"), document.String("title"), "application/json", "Bike 文档的 compact JSON 视图"
			if markdown {
				uri = "bike://document-markdown/" + id
				name += ".md"
				title += " Markdown"
				mime = "text/markdown"
				description = "Bike 文档的 Markdown 视图"
			}
			value := map[string]any{"uri": uri, "name": name, "title": title, "description": description, "mimeType": mime, "annotations": map[string]any{"audience": []string{"assistant"}, "priority": 0.8, "lastModified": document.String("updatedAt")}}
			raw, _ := json.Marshal(value)
			var resource mcp.Resource
			if err := json.Unmarshal(raw, &resource); err != nil {
				return nil, err
			}
			resources = append(resources, &resource)
		}
	}
	return &mcp.ListResourcesResult{Resources: resources}, nil
}
func readResource(ctx context.Context, store Store, uri string) (*mcp.ReadResourceResult, error) {
	snapshot, err := store.Load(ctx)
	if err != nil {
		return nil, err
	}
	workspace, err := snapshotWorkspace(snapshot)
	if err != nil {
		return nil, err
	}
	mime := "application/json"
	var value any
	switch uri {
	case "bike://workspace/summary":
		value, err = summary(snapshot)
	case "bike://documents":
		value = listDocuments(workspace, ordered("limit", float64(100)))
	default:
		parsed, parseError := url.Parse(uri)
		if parseError != nil || parsed.Scheme != "bike" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, mcp.ResourceNotFoundError(uri)
		}
		parts := strings.Split(strings.TrimPrefix(parsed.EscapedPath(), "/"), "/")
		for index, part := range parts {
			parts[index], err = url.PathUnescape(part)
			if err != nil {
				return nil, mcp.ResourceNotFoundError(uri)
			}
		}
		if (parsed.Host == "document" || parsed.Host == "document-markdown") && len(parts) == 1 {
			format := "compact"
			if parsed.Host == "document-markdown" {
				format = "markdown"
				mime = "text/markdown"
			}
			document, readError := getDocument(workspace, ordered("documentId", parts[0], "format", format), snapshot.Live)
			if readError != nil {
				return nil, readError
			}
			value = document.Get("content")
		} else if parsed.Host == "node" && len(parts) == 2 {
			value, err = getNode(workspace, ordered("documentId", parts[0], "nodeId", parts[1], "includeAncestors", true, "includeSiblings", false, "childrenDepth", float64(3)), snapshot.Live)
		} else {
			return nil, mcp.ResourceNotFoundError(uri)
		}
	}
	if err != nil {
		return nil, err
	}
	text, ok := value.(string)
	if !ok {
		encoded, err := contracts.Stringify(value, true, false)
		if err != nil {
			return nil, err
		}
		text = string(encoded)
	}
	if len(contracts.TextEncoder(text)) > 8*1024*1024 {
		return nil, fmt.Errorf("资源超过 8 MiB，请缩小读取范围")
	}
	return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: uri, MIMEType: mime, Text: text}}}, nil
}
func getPrompt(name string, args map[string]string, definitions catalog) (*mcp.GetPromptResult, error) {
	fail := func(message string) (*mcp.GetPromptResult, error) {
		return nil, &jsonrpc.Error{Code: -32602, Message: message}
	}
	if args["documentId"] == "" {
		return fail("documentId 不能为空")
	}
	target := "Bike 文档 " + args["documentId"]
	if args["nodeId"] != "" {
		target += " 中的节点 " + args["nodeId"]
	}
	instruction := definitions.Templates[name].Instruction
	var text string
	switch name {
	case "summarize_outline":
		style := args["style"]
		if style == "" {
			style = "brief"
		}
		if style != "brief" && style != "detailed" && style != "executive" {
			return fail("style 无效")
		}
		text = "请先通过 Bike MCP 读取 " + target + "，再用 " + style + " 风格总结。" + instruction
	case "outline_to_prd":
		audience := args["audience"]
		if audience == "" {
			audience = "mixed"
		}
		if audience != "engineering" && audience != "product" && audience != "mixed" {
			return fail("audience 无效")
		}
		text = "请先读取 " + target + "，面向 " + audience + " 读者。" + instruction
	case "outline_to_tasks":
		if _, exists := args["includeAcceptanceCriteria"]; exists {
			return fail("includeAcceptanceCriteria 参数需要布尔值")
		}
		text = "请先读取 " + target + "，拆成可执行任务。每个任务都给出验收标准。 请按依赖顺序排列。"
	case "review_outline_structure", "outline_to_meeting":
		text = "请先读取 " + target + "。" + instruction
	default:
		return fail("未知 prompt")
	}
	return &mcp.GetPromptResult{Messages: []*mcp.PromptMessage{{Role: "user", Content: &mcp.TextContent{Text: text}}}}, nil
}

func resourceDocumentCompletion(params *mcp.CompleteParams) bool {
	if params.Ref == nil || params.Ref.Type != "ref/resource" || params.Argument.Name != "documentId" {
		return false
	}
	switch params.Ref.URI {
	case "bike://document/{documentId}", "bike://document-markdown/{documentId}", "bike://node/{documentId}/{nodeId}":
		return true
	}
	return false
}

func completeResource(ctx context.Context, store Store, definitions catalog, params *mcp.CompleteParams) (*mcp.CompleteResult, error) {
	result := &mcp.CompleteResult{Completion: mcp.CompletionResultDetails{Values: []string{}}}
	if params == nil || params.Ref == nil {
		return nil, &jsonrpc.Error{Code: -32602, Message: "补全引用无效"}
	}
	found := false
	if params.Ref.Type == "ref/prompt" {
		for _, prompt := range definitions.Prompts {
			if prompt.Name == params.Ref.Name {
				found = true
			}
		}
	} else {
		for _, resource := range definitions.Resources {
			if resource.URI == params.Ref.URI {
				found = true
			}
		}
		for _, template := range definitions.ResourceTemplates {
			if template.URITemplate == params.Ref.URI {
				found = true
			}
		}
	}
	if !found {
		return nil, &jsonrpc.Error{Code: -32602, Message: "补全引用不存在"}
	}
	if !resourceDocumentCompletion(params) {
		return result, nil
	}
	snapshot, err := store.Load(ctx)
	if err != nil {
		return nil, err
	}
	workspace, err := snapshotWorkspace(snapshot)
	if err != nil {
		return nil, err
	}
	for _, document := range liveDocuments(workspace) {
		if strings.Contains(document.String("title"), params.Argument.Value) || strings.Contains(document.String("id"), params.Argument.Value) {
			result.Completion.Values = append(result.Completion.Values, document.String("id"))
			if len(result.Completion.Values) == 20 {
				break
			}
		}
	}
	result.Completion.Total = len(result.Completion.Values)
	return result, nil
}
