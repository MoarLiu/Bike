package mcp

import (
	"fmt"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

var writeTools = map[string]bool{"create_document": true, "update_document_title": true, "create_node": true, "append_children": true, "update_node": true, "set_node_checked": true, "move_node": true, "delete_node": true}

func usedIDs(workspace *object) map[string]bool {
	ids := map[string]bool{}
	for _, document := range liveDocuments(workspace) {
		ids[document.String("id")] = true
		walkNodes(document.Array("nodes"), func(node *object, _ []int, _ []*object) { ids[node.String("id")] = true })
	}
	return ids
}
func createdIDs(nodes []any) []any {
	result := []any{}
	stack := append([]any{}, nodes...)
	for len(stack) > 0 {
		node := asObject(stack[len(stack)-1])
		stack = stack[:len(stack)-1]
		result = append(result, node.Get("id"))
		stack = append(stack, node.Array("children")...)
	}
	return result
}
func writableNode(raw *object, ids map[string]bool) *object {
	if raw == nil {
		raw = contracts.NewObject()
	}
	node := ordered("id", uniqueID(contracts.TrimJS(raw.String("id")), ids, "node"), "text", textOr(raw.Get("text"), "未命名主题"), "note", textOr(raw.Get("note"), ""), "checked", raw.Get("checked") == true, "collapsed", raw.Get("collapsed") == true, "color", normalizeColor(raw.Get("color")), "children", []any{})
	if value, ok := raw.Get("codeBlock").(string); ok {
		node.Set("codeBlock", normalizedLines(value))
	}
	if language := contracts.TrimJS(raw.String("codeLanguage")); language != "" {
		node.Set("codeLanguage", contracts.SliceUTF16(language, 0, 80))
	}
	node.Set("isTodo", raw.Get("isTodo") == true || raw.Get("checked") == true)
	children := []any{}
	for _, child := range raw.Array("children") {
		children = append(children, writableNode(asObject(child), ids))
	}
	node.Set("children", children)
	return node
}
func confirmationNode(node *object) *object {
	result := ordered("id", node.Get("id"), "text", node.Get("text"), "note", node.Get("note"), "checked", node.Get("checked") == true, "collapsed", node.Get("collapsed") == true, "color", normalizeColor(node.Get("color")))
	for _, field := range []string{"codeBlock", "codeLanguage"} {
		if isString(node.Get(field)) {
			result.Set(field, node.Get(field))
		}
	}
	result.Set("isTodo", node.Get("isTodo") == true)
	children := []any{}
	for _, raw := range node.Array("children") {
		children = append(children, confirmationNode(asObject(raw)))
	}
	result.Set("children", children)
	return result
}
func writableBudget(nodes []any, existing, base int) error {
	type frame struct {
		node  *object
		depth int
	}
	stack := []frame{}
	for _, node := range nodes {
		stack = append(stack, frame{asObject(node), base})
	}
	count := 0
	for len(stack) > 0 {
		item := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		count++
		if item.depth > 64 {
			return fmt.Errorf("写入节点深度超过上限 64")
		}
		if existing+count > 2000 {
			return fmt.Errorf("写入节点数量超过上限 2000")
		}
		for _, child := range item.node.Array("children") {
			stack = append(stack, frame{asObject(child), item.depth + 1})
		}
	}
	return nil
}
func markUpdated(document *object, at string) {
	if document.Child("knowledge") != nil {
		document.Set("knowledge", anchorKnowledge(document))
	}
	document.Set("updatedAt", at)
	document.Delete("markdownSource")
	document.Delete("markdownUpdatedAt")
}
func label(node *object) string {
	value := node.String("text")
	if value == "" {
		return "未命名主题"
	}
	return value
}
func position(args *object) string {
	if args.String("position") == "first" {
		return "first"
	}
	return "last"
}
func insertNodes(document *object, parentID string, nodes []any, where string) (any, int, error) {
	owner, key := document, "nodes"
	var id any
	if parentID != "" {
		parent, _, _, err := nodeByID(document, parentID)
		if err != nil {
			return nil, 0, err
		}
		owner, key = parent, "children"
		parent.Set("collapsed", false)
		id = parent.Get("id")
	}
	container := owner.Array(key)
	index := len(container)
	if where == "first" {
		index = 0
	}
	next := append([]any{}, container[:index]...)
	next = append(next, nodes...)
	next = append(next, container[index:]...)
	owner.Set(key, next)
	return id, index, nil
}
func removeNode(document *object, path []int) *object {
	owner, key := document, "nodes"
	for _, index := range path[:len(path)-1] {
		owner = asObject(owner.Array(key)[index])
		key = "children"
	}
	index := path[len(path)-1]
	container := owner.Array(key)
	node := asObject(container[index])
	next := append([]any{}, container[:index]...)
	next = append(next, container[index+1:]...)
	owner.Set(key, next)
	return node
}
func writePreview(operation, summary string, documents, nodes, changes []any, confirmation *object) *object {
	return ordered("summary", summary, "affected", ordered("documentIds", documents, "nodeIds", nodes), "preview", ordered("operation", operation, "changes", changes), "confirmationArgs", confirmation)
}

func applyWrite(workspace *object, operation string, args *object, at string) (*object, error) {
	if operation == "create_document" {
		rawNodes := args.Array("initialNodes")
		budgetNodes := rawNodes
		if len(budgetNodes) == 0 {
			budgetNodes = []any{ordered("text", "未命名主题")}
		}
		if err := writableBudget(budgetNodes, 0, 0); err != nil {
			return nil, err
		}
		ids := usedIDs(workspace)
		nodes := []any{}
		for _, raw := range rawNodes {
			nodes = append(nodes, writableNode(asObject(raw), ids))
		}
		id := uniqueID(contracts.TrimJS(args.String("documentId")), ids, "doc")
		title := contracts.TrimJS(args.String("title"))
		if title == "" {
			title = "未命名文档"
		}
		if len(nodes) == 0 {
			nodes = append(nodes, writableNode(ordered("text", "未命名主题"), ids))
		}
		document := ordered("id", id, "title", title, "createdAt", at, "updatedAt", at, "nodes", nodes)
		workspace.Set("documents", append(workspace.Array("documents"), document))
		workspace.Set("activeDocumentId", id)
		confirmed := []any{}
		for _, node := range nodes {
			confirmed = append(confirmed, confirmationNode(asObject(node)))
		}
		return writePreview(operation, "创建文档："+title, []any{id}, createdIDs(nodes), []any{ordered("type", operation, "documentId", id, "title", title, "nodeCount", treeCount(nodes))}, ordered("documentId", id, "title", title, "initialNodes", confirmed)), nil
	}
	document, err := documentByID(workspace, args.String("documentId"))
	if err != nil {
		return nil, err
	}
	if document.Child("knowledge") != nil {
		document.Set("knowledge", anchorKnowledge(document))
	}
	id := document.Get("id")
	if operation == "update_document_title" {
		title := contracts.TrimJS(args.String("title"))
		if title == "" {
			return nil, fmt.Errorf("title 不能为空")
		}
		before := document.String("title")
		updated, err := renameWorkspace(workspace, document.String("id"), "", title)
		if err != nil {
			return nil, err
		}
		for _, updatedID := range updated {
			item, _ := documentByID(workspace, updatedID)
			markUpdated(item, at)
		}
		if len(updated) == 0 {
			markUpdated(document, at)
		}
		return writePreview(operation, "更新文档标题："+before+" -> "+title, []any{id}, []any{}, []any{ordered("type", operation, "documentId", id, "field", "title", "before", before, "after", title)}, ordered("documentId", id, "title", title)), nil
	}
	if operation == "create_node" || operation == "append_children" {
		rawNodes := []any{args}
		if operation == "append_children" {
			rawNodes = args.Array("children")
			if len(rawNodes) == 0 {
				return nil, fmt.Errorf("children 至少需要一个节点")
			}
		}
		parentID := args.String("parentNodeId")
		base := 0
		if parentID != "" {
			_, path, _, err := nodeByID(document, parentID)
			if err != nil {
				return nil, fmt.Errorf("找不到父节点：%s", parentID)
			}
			base = len(path)
		}
		if err := writableBudget(rawNodes, treeCount(document.Array("nodes")), base); err != nil {
			return nil, err
		}
		ids := usedIDs(workspace)
		nodes := []any{}
		for _, raw := range rawNodes {
			nodes = append(nodes, writableNode(asObject(raw), ids))
		}
		where := position(args)
		if operation == "append_children" {
			where = "last"
		}
		parent, index, err := insertNodes(document, parentID, nodes, where)
		if err != nil {
			return nil, err
		}
		markUpdated(document, at)
		confirmation := ordered("documentId", id)
		if parent != nil {
			confirmation.Set("parentNodeId", parent)
		}
		if operation == "create_node" {
			node := asObject(nodes[0])
			confirmation.Set("position", where)
			input := confirmationNode(node)
			for _, key := range input.Keys {
				confirmation.Set(key, input.Get(key))
			}
			return writePreview(operation, "创建节点："+label(node), []any{id}, createdIDs(nodes), []any{ordered("type", operation, "documentId", id, "parentNodeId", parent, "index", index, "nodeId", node.Get("id"), "text", node.Get("text"))}, confirmation), nil
		}
		confirmed := []any{}
		for _, raw := range nodes {
			confirmed = append(confirmed, confirmationNode(asObject(raw)))
		}
		confirmation.Set("children", confirmed)
		nodeIDs := createdIDs(nodes)
		return writePreview(operation, fmt.Sprintf("追加 %d 个子节点", len(nodes)), []any{id}, nodeIDs, []any{ordered("type", operation, "documentId", id, "parentNodeId", parent, "index", index, "count", len(nodes), "nodeIds", nodeIDs)}, confirmation), nil
	}
	node, path, _, err := nodeByID(document, args.String("nodeId"))
	if err != nil {
		return nil, err
	}
	nodeID := node.Get("id")
	switch operation {
	case "set_node_checked":
		before := node.Get("checked") == true
		checked := args.Get("checked") == true
		node.Set("checked", checked)
		node.Set("isTodo", true)
		markUpdated(document, at)
		prefix := "取消完成"
		if checked {
			prefix = "完成"
		}
		return writePreview(operation, prefix+"节点："+label(node), []any{id}, []any{nodeID}, []any{ordered("type", operation, "documentId", id, "nodeId", nodeID, "path", path, "field", "checked", "before", before, "after", checked)}, ordered("documentId", id, "nodeId", nodeID, "checked", checked)), nil
	case "delete_node":
		deleted := createdIDs([]any{node})
		text := label(node)
		removeNode(document, path)
		if len(document.Array("nodes")) == 0 {
			document.Set("nodes", []any{writableNode(ordered("text", "未命名主题"), usedIDs(workspace))})
		}
		markUpdated(document, at)
		return writePreview(operation, "删除节点："+text, []any{id}, deleted, []any{ordered("type", operation, "documentId", id, "nodeId", nodeID, "path", path, "deletedNodeCount", len(deleted))}, ordered("documentId", id, "nodeId", nodeID)), nil
	case "move_node":
		parentID := args.String("targetParentNodeId")
		if parentID == args.String("nodeId") {
			return nil, fmt.Errorf("不能把节点移动到自身下面")
		}
		base := 0
		if parentID != "" {
			_, targetPath, _, err := nodeByID(document, parentID)
			if err != nil {
				return nil, fmt.Errorf("找不到目标父节点：%s", parentID)
			}
			base = len(targetPath)
			if len(targetPath) > len(path) {
				inside := true
				for index, value := range path {
					inside = inside && targetPath[index] == value
				}
				if inside {
					return nil, fmt.Errorf("不能把节点移动到自己的子节点下面")
				}
			}
		}
		maximum := 0
		walkNodes(node.Array("children"), func(_ *object, at []int, _ []*object) { maximum = max(maximum, len(at)) })
		if base+maximum > 64 {
			return nil, fmt.Errorf("写入节点深度超过上限 64")
		}
		removeNode(document, path)
		parent, index, err := insertNodes(document, parentID, []any{node}, position(args))
		if err != nil {
			return nil, err
		}
		_, after, _, _ := nodeByID(document, node.String("id"))
		markUpdated(document, at)
		confirmation := ordered("documentId", id, "nodeId", nodeID)
		if parent != nil {
			confirmation.Set("targetParentNodeId", parent)
		}
		confirmation.Set("position", position(args))
		return writePreview(operation, "移动节点："+label(node), []any{id}, []any{nodeID}, []any{ordered("type", operation, "documentId", id, "nodeId", nodeID, "beforePath", path, "afterPath", after, "targetParentNodeId", parent, "index", index)}, confirmation), nil
	case "update_node":
		beforeText := node.String("text")
		if args.Has("text") && args.String("text") != beforeText {
			updated, err := renameWorkspace(workspace, document.String("id"), node.String("id"), args.String("text"))
			if err != nil {
				return nil, err
			}
			for _, updatedID := range updated {
				if updatedID != document.String("id") {
					item, _ := documentByID(workspace, updatedID)
					markUpdated(item, at)
				}
			}
			node, path, _, _ = nodeByID(document, args.String("nodeId"))
		}
		fields := updateFields(node, args)
		if len(fields) == 0 && beforeText == node.String("text") {
			return nil, fmt.Errorf("至少需要提供一个可更新字段")
		}
		for _, raw := range fields {
			field := asObject(raw)
			if field.String("field") == "note" {
				relocateReferences(document, node.String("id"), "note", textOr(field.Get("before"), ""), node.String("note"))
			}
		}
		hasText := false
		for _, raw := range fields {
			hasText = hasText || asObject(raw).String("field") == "text"
		}
		if args.Has("text") && !hasText {
			fields = append([]any{ordered("field", "text", "before", beforeText, "after", node.Get("text"))}, fields...)
		}
		markUpdated(document, at)
		confirmation := ordered("documentId", id, "nodeId", nodeID)
		for _, raw := range fields {
			field := asObject(raw)
			if field.Has("after") {
				confirmation.Set(field.String("field"), field.Get("after"))
			} else if field.String("field") == "codeLanguage" {
				confirmation.Set("codeLanguage", "")
			}
		}
		return writePreview(operation, "更新节点："+label(node), []any{id}, []any{nodeID}, []any{ordered("type", operation, "documentId", id, "nodeId", nodeID, "path", path, "fields", fields)}, confirmation), nil
	default:
		return nil, fmt.Errorf("未知写入工具")
	}
}
func updateFields(node, args *object) []any {
	changes := []any{}
	for _, field := range []string{"text", "note", "color", "collapsed", "checked", "isTodo", "codeBlock", "codeLanguage"} {
		if !args.Has(field) {
			continue
		}
		var after any
		present := true
		switch field {
		case "text", "note":
			after = textOr(args.Get(field), "")
		case "color":
			after = normalizeColor(args.Get(field))
		case "collapsed", "checked", "isTodo":
			after = args.Get(field) == true
		case "codeBlock":
			value, ok := args.Get(field).(string)
			present = ok
			after = normalizedLines(value)
		case "codeLanguage":
			value := contracts.TrimJS(args.String(field))
			present = value != ""
			after = contracts.SliceUTF16(value, 0, 80)
		}
		if present && node.Get(field) == after || !present && !node.Has(field) {
			continue
		}
		change := ordered("field", field)
		if node.Has(field) {
			change.Set("before", node.Get(field))
		}
		if present {
			node.Set(field, after)
			change.Set("after", after)
		} else {
			node.Delete(field)
		}
		changes = append(changes, change)
	}
	for _, raw := range changes {
		if asObject(raw).String("field") == "checked" && node.Get("checked") == true {
			node.Set("isTodo", true)
		}
	}
	return changes
}
