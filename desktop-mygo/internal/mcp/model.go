package mcp

import (
	"crypto/rand"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/services"
)

type object = contracts.Object

func ordered(pairs ...any) *object {
	result := contracts.NewObject()
	for index := 0; index < len(pairs); index += 2 {
		result.Set(pairs[index].(string), pairs[index+1])
	}
	return result
}
func textOr(value any, fallback string) string {
	if value, ok := value.(string); ok {
		return value
	}
	return fallback
}
func normalizedLines(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
}
func newID(prefix string) string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	value[6] = value[6]&15 | 64
	value[8] = value[8]&63 | 128
	return fmt.Sprintf("%s_%x-%x-%x-%x-%x", prefix, value[:4], value[4:6], value[6:8], value[8:10], value[10:])
}
func uniqueID(value string, used map[string]bool, prefix string) string {
	id := contracts.TrimJS(value)
	if id == "" || used[id] {
		id = newID(prefix)
	}
	used[id] = true
	return id
}
func normalizeColor(value any) string {
	switch value {
	case "plain", "blue", "green", "amber", "rose":
		return value.(string)
	default:
		return "plain"
	}
}
func normalizeNode(node *object, used map[string]bool, depth int, count *int) error {
	*count++
	if depth > contracts.Limits.DesktopDepth || *count > contracts.Limits.DocumentNodes {
		return fmt.Errorf("主题数量或深度超过处理预算")
	}
	originalChildren := node.Array("children")
	node.Set("id", uniqueID(node.String("id"), used, "node"))
	node.Set("text", textOr(node.Get("text"), "未命名主题"))
	node.Set("note", textOr(node.Get("note"), ""))
	node.Set("checked", node.Get("checked") == true)
	node.Set("collapsed", node.Get("collapsed") == true)
	node.Set("color", normalizeColor(node.Get("color")))
	node.Set("children", []any{})
	heading := node.Get("headingLevel")
	if heading != float64(1) && heading != float64(2) && heading != float64(3) {
		heading = float64(0)
	}
	node.Set("headingLevel", heading)
	for _, field := range []string{"bold", "italic", "underline", "strike", "highlight"} {
		node.Set(field, node.Get(field) == true)
	}
	for _, field := range []string{"icon", "imageName", "imageAlt"} {
		if value, ok := node.Get(field).(string); ok {
			node.Set(field, value)
		} else {
			node.Delete(field)
		}
	}
	if table, ok := node.Get("table").([]any); ok {
		normalized := []any{}
		for _, raw := range table {
			if row, ok := raw.([]any); ok {
				cells := []any{}
				for _, cell := range row {
					cells = append(cells, textOr(cell, ""))
				}
				normalized = append(normalized, cells)
			}
		}
		node.Set("table", normalized)
	} else {
		node.Delete("table")
	}
	if value, ok := node.Get("codeBlock").(string); ok {
		node.Set("codeBlock", normalizedLines(value))
	} else {
		node.Delete("codeBlock")
	}
	language := contracts.TrimJS(node.String("codeLanguage"))
	if language != "" {
		node.Set("codeLanguage", contracts.SliceUTF16(language, 0, 80))
	} else {
		node.Delete("codeLanguage")
	}
	node.Set("isTodo", node.Get("isTodo") == true)
	children := []any{}
	for _, raw := range originalChildren {
		child, ok := raw.(*object)
		if !ok {
			return fmt.Errorf("附件主题结构无效，原数据已保留")
		}
		if err := normalizeNode(child, used, depth+1, count); err != nil {
			return err
		}
		children = append(children, child)
	}
	node.Set("children", children)
	return nil
}
func normalizeDocument(document *object, used map[string]bool, now string) error {
	rawNodes, ok := document.Get("nodes").([]any)
	if !ok {
		return fmt.Errorf("文档缺少有效主题数组，原文件已保留")
	}
	count := 0
	for _, raw := range rawNodes {
		node, ok := raw.(*object)
		if !ok {
			return fmt.Errorf("附件主题结构无效，原数据已保留")
		}
		if err := normalizeNode(node, used, 1, &count); err != nil {
			return err
		}
	}
	document.Set("id", uniqueID(document.String("id"), used, "node"))
	title := contracts.TrimJS(document.String("title"))
	if title == "" {
		title = "未命名文档"
	}
	document.Set("title", title)
	document.Set("createdAt", textOr(document.Get("createdAt"), now))
	document.Set("updatedAt", textOr(document.Get("updatedAt"), now))
	if source, ok := document.Get("markdownSource").(string); ok {
		document.Set("markdownSource", normalizedLines(source))
		if contracts.TrimJS(document.String("markdownUpdatedAt")) == "" {
			document.Set("markdownUpdatedAt", document.Get("updatedAt"))
		}
	} else {
		document.Delete("markdownSource")
		if _, ok := document.Get("markdownUpdatedAt").(string); !ok || contracts.TrimJS(document.String("markdownUpdatedAt")) == "" {
			document.Delete("markdownUpdatedAt")
		}
	}
	if value, ok := document.Get("isShortcut").(bool); ok {
		document.Set("isShortcut", value)
	} else {
		document.Delete("isShortcut")
	}
	document.Set("nodes", rawNodes)
	return nil
}
func normalizeWorkspace(workspace *object) (*object, error) {
	if workspace == nil {
		return nil, fmt.Errorf("导入文件不是有效工作区")
	}
	version := workspace.Get("version")
	if workspace.Has("version") && version != float64(1) && version != float64(2) && version != float64(3) {
		return nil, fmt.Errorf("工作区版本暂不支持，原文件已保留")
	}
	documents, ok := workspace.Get("documents").([]any)
	if !ok {
		return nil, fmt.Errorf("导入文件不是有效工作区")
	}
	if len(documents) == 0 {
		return nil, fmt.Errorf("工作区至少需要一个文档")
	}
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	used := map[string]bool{}
	active := workspace.String("activeDocumentId")
	found := false
	for index, raw := range documents {
		document, ok := raw.(*object)
		if !ok {
			return nil, fmt.Errorf("第 %d 个文档无法读取：导入文件不是有效文档；原文件已保留", index+1)
		}
		if err := normalizeDocument(document, used, now); err != nil {
			return nil, fmt.Errorf("第 %d 个文档无法读取：%s；原文件已保留", index+1, err)
		}
		if document.String("id") == active {
			found = true
		}
	}
	if version != float64(2) && version != float64(3) {
		version = float64(1)
	}
	workspace.Set("version", version)
	if !found {
		active = documents[0].(*object).String("id")
	}
	workspace.Set("activeDocumentId", active)
	workspace.Set("documents", documents)
	if entries, ok := workspace.Get("trash").([]any); ok {
		normalized := []any{}
		trashIDs := map[string]bool{}
		for _, raw := range entries {
			entry, ok := raw.(*object)
			if !ok {
				return nil, fmt.Errorf("回收站记录无效，原文件已保留")
			}
			document := entry.Child("document")
			if document == nil || contracts.TrimJS(document.String("id")) == "" || !validDate(entry.String("deletedAt")) {
				return nil, fmt.Errorf("回收站记录无效，原文件已保留")
			}
			if err := normalizeDocument(document, map[string]bool{}, now); err != nil {
				return nil, err
			}
			index, ok := entry.Get("originalIndex").(float64)
			if !ok || index < 0 || math.IsInf(index, 0) || index != math.Trunc(index) {
				index = 0
			}
			normalized = append(normalized, ordered("id", uniqueID(entry.String("id"), trashIDs, "trash"), "document", document, "deletedAt", entry.String("deletedAt"), "originalIndex", index))
		}
		if len(normalized) > 0 {
			workspace.Set("trash", normalized)
		} else {
			workspace.Delete("trash")
		}
	} else {
		workspace.Delete("trash")
	}
	encoded, err := contracts.Stringify(workspace, false, false)
	if err != nil {
		return nil, err
	}
	_, _, assets, err := services.WorkspaceJSON(encoded)
	if err != nil {
		return nil, err
	}
	if version == float64(1) {
		hasAttachments := len(assets) > 0
		for _, raw := range documents {
			hasAttachments = hasAttachments || raw.(*object).Has("attachments")
		}
		if hasAttachments {
			return nil, fmt.Errorf("附件数据需要 version 2 工作区，原文件已保留")
		}
	}
	return workspace, nil
}
func validDate(value string) bool {
	_, ok := parseDocumentDate(value)
	return ok
}
func asObject(value any) *object { result, _ := value.(*object); return result }
func documentByID(workspace *object, id string) (*object, error) {
	for _, raw := range workspace.Array("documents") {
		document := asObject(raw)
		if document.String("id") == id {
			return document, nil
		}
	}
	return nil, fmt.Errorf("找不到文档：%s", id)
}
func walkNodes(nodes []any, visit func(*object, []int, []*object)) {
	var walk func([]any, []int, []*object)
	walk = func(nodes []any, path []int, ancestors []*object) {
		for index, raw := range nodes {
			node := asObject(raw)
			at := append(append([]int{}, path...), index)
			visit(node, at, ancestors)
			walk(node.Array("children"), at, append(append([]*object{}, ancestors...), node))
		}
	}
	walk(nodes, nil, nil)
}
func nodeByID(document *object, id string) (*object, []int, []*object, error) {
	var visit func([]any, []int, []*object) (*object, []int, []*object)
	visit = func(nodes []any, path []int, parents []*object) (*object, []int, []*object) {
		for index, raw := range nodes {
			node := asObject(raw)
			at := append(path, index)
			if node.String("id") == id {
				return node, append([]int{}, at...), append([]*object{}, parents...)
			}
			if found, path, ancestors := visit(node.Array("children"), at, append(parents, node)); found != nil {
				return found, path, ancestors
			}
		}
		return nil, nil, nil
	}
	if node, path, parents := visit(document.Array("nodes"), nil, nil); node != nil {
		return node, path, parents, nil
	}
	return nil, nil, nil, fmt.Errorf("找不到节点：%s", id)
}
