package mcp

import (
	"encoding/json"
	"fmt"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

func option(args *object, key string, fallback, minimum, maximum int) int {
	value, ok := args.Get(key).(float64)
	if !ok || math.IsInf(value, 0) || math.IsNaN(value) {
		return fallback
	}
	return max(minimum, min(maximum, int(math.Floor(value))))
}
func snapshotWorkspace(snapshot Snapshot) (*object, error) {
	if snapshot.Ordered != nil {
		return snapshot.Ordered, nil
	}
	encoded, err := json.Marshal(snapshot.Workspace)
	if err != nil {
		return nil, err
	}
	parsed, err := contracts.ParseJSON(encoded)
	return asObject(parsed), err
}
func treeCount(nodes []any) int {
	count := 0
	stack := append([]any{}, nodes...)
	for len(stack) > 0 {
		node := asObject(stack[len(stack)-1])
		stack = stack[:len(stack)-1]
		count++
		stack = append(stack, node.Array("children")...)
	}
	return count
}
func documentStats(document *object) *object {
	return ordered("id", document.Get("id"), "title", document.Get("title"), "createdAt", document.Get("createdAt"), "updatedAt", document.Get("updatedAt"), "nodeCount", treeCount(document.Array("nodes")), "topLevelNodeCount", len(document.Array("nodes")))
}
func listDocuments(workspace, args *object) *object {
	query := args.String("query")
	needle := lower(contracts.TrimJS(query))
	limit := option(args, "limit", 20, 1, 100)
	documents := []*object{}
	for _, document := range liveDocuments(workspace) {
		if needle == "" || strings.Contains(lower(document.String("title")), needle) {
			documents = append(documents, document)
		}
	}
	sort.SliceStable(documents, func(i, j int) bool {
		a, ae := time.Parse(time.RFC3339Nano, documents[i].String("updatedAt"))
		b, be := time.Parse(time.RFC3339Nano, documents[j].String("updatedAt"))
		return ae == nil && be == nil && a.After(b)
	})
	result := []any{}
	for _, document := range documents[:min(limit, len(documents))] {
		item := documentStats(document)
		if args.Get("includeStats") == false {
			item.Delete("nodeCount")
			item.Delete("topLevelNodeCount")
		}
		result = append(result, item)
	}
	return ordered("query", query, "documents", result)
}
func snippet(value, query string) string {
	compact := contracts.CompactWhitespace(value)
	length := contracts.UTF16Length(compact)
	if length <= 180 {
		return compact
	}
	folded := lower(compact)
	at := strings.Index(folded, lower(query))
	if at < 0 {
		return contracts.SliceUTF16(compact, 0, 179) + "…"
	}
	index := contracts.UTF16Length(folded[:at])
	start := max(0, index-90)
	end := min(length, start+180)
	prefix, suffix := "", ""
	if start > 0 {
		prefix = "…"
	}
	if end < length {
		suffix = "…"
	}
	return prefix + contracts.SliceUTF16(compact, start, end) + suffix
}
func searchOutline(workspace, args *object, live bool) (*object, error) {
	query := contracts.TrimJS(args.String("query"))
	if query == "" {
		return nil, fmt.Errorf("query 不能为空")
	}
	maximum := 50
	if live {
		maximum = 100
	}
	limit := option(args, "limit", 20, 1, maximum)
	fields := map[string]bool{}
	if !args.Has("fields") {
		fields = map[string]bool{"title": true, "text": true, "note": true}
	} else {
		for _, field := range args.Array("fields") {
			if field, ok := field.(string); ok {
				fields[field] = true
			}
		}
	}
	documents := liveDocuments(workspace)
	if args.String("documentId") != "" {
		document, err := documentByID(workspace, args.String("documentId"))
		if err != nil {
			return nil, err
		}
		documents = []*object{document}
	}
	matches := []any{}
	needle := lower(query)
	add := func(document *object, nodeID any, field, value string, path []int, breadcrumb []string) {
		matches = append(matches, ordered("documentId", document.Get("id"), "documentTitle", document.Get("title"), "nodeId", nodeID, "field", field, "snippet", snippet(value, query), "breadcrumb", breadcrumb, "path", path))
	}
	for _, document := range documents {
		if fields["title"] && strings.Contains(lower(document.String("title")), needle) {
			add(document, nil, "title", document.String("title"), []int{}, []string{document.String("title")})
		}
		if len(matches) >= limit {
			break
		}
		walkNodes(document.Array("nodes"), func(node *object, path []int, parents []*object) {
			if len(matches) >= limit {
				return
			}
			breadcrumb := []string{document.String("title")}
			for _, parent := range parents {
				label := parent.String("text")
				if label == "" {
					label = "未命名主题"
				}
				breadcrumb = append(breadcrumb, label)
			}
			label := node.String("text")
			if label == "" {
				label = "未命名主题"
			}
			breadcrumb = append(breadcrumb, label)
			for _, field := range []string{"text", "note"} {
				if len(matches) < limit && fields[field] && strings.Contains(lower(node.String(field)), needle) {
					add(document, node.Get("id"), field, node.String(field), path, breadcrumb)
				}
			}
		})
		if len(matches) >= limit {
			break
		}
	}
	return ordered("query", query, "limit", limit, "matches", matches, "truncated", len(matches) >= limit), nil
}
func nodeFields(document, node *object, path []int, parents []*object) *object {
	result := contracts.NewObject()
	for _, field := range []string{"id", "text", "note", "checked", "collapsed", "color"} {
		if node.Has(field) {
			result.Set(field, node.Get(field))
		}
	}
	heading := node.Get("headingLevel")
	if heading == nil {
		heading = float64(0)
	}
	result.Set("headingLevel", heading)
	for _, field := range []string{"bold", "italic", "underline", "strike", "highlight"} {
		result.Set(field, node.Get(field) == true)
	}
	for _, field := range []string{"icon", "imageName", "imageAlt", "attachmentRefs"} {
		if node.Has(field) {
			result.Set(field, node.Get(field))
		}
	}
	if len(node.Array("attachmentRefs")) > 0 {
		result.Set("attachmentAvailability", "unknown")
	}
	for _, field := range []string{"table", "codeBlock", "codeLanguage"} {
		if node.Has(field) {
			result.Set(field, node.Get(field))
		}
	}
	result.Set("isTodo", node.Get("isTodo") == true)
	breadcrumb := []string{document.String("title")}
	var parentID any
	for _, parent := range parents {
		label := parent.String("text")
		if label == "" {
			label = "未命名主题"
		}
		breadcrumb = append(breadcrumb, label)
		parentID = parent.Get("id")
	}
	label := node.String("text")
	if label == "" {
		label = "未命名主题"
	}
	breadcrumb = append(breadcrumb, label)
	result.Set("path", path)
	result.Set("breadcrumb", breadcrumb)
	result.Set("parentId", parentID)
	result.Set("depth", len(path)-1)
	result.Set("childCount", len(node.Array("children")))
	result.Set("descendantCount", treeCount(node.Array("children")))
	return result
}

type readBudget struct {
	remaining int
	unlimited bool
	truncated bool
}

func compactNode(document, node *object, path []int, parents []*object, depth int, budget *readBudget) *object {
	if !budget.unlimited && budget.remaining <= 0 {
		budget.truncated = true
		return nil
	}
	budget.remaining--
	result := nodeFields(document, node, path, parents)
	children := []any{}
	if depth > 0 {
		for index, raw := range node.Array("children") {
			if !budget.unlimited && budget.remaining <= 0 {
				budget.truncated = true
				break
			}
			child := compactNode(document, asObject(raw), append(append([]int{}, path...), index), append(append([]*object{}, parents...), node), depth-1, budget)
			if child != nil {
				children = append(children, child)
			}
		}
	}
	result.Set("children", children)
	return result
}
func getDocument(workspace, args *object, live bool) (*object, error) {
	document, err := documentByID(workspace, args.String("documentId"))
	if err != nil {
		return nil, err
	}
	format := args.String("format")
	result := ordered("documentId", document.Get("id"), "title", document.Get("title"))
	if format == "json" {
		result.Set("format", format)
		result.Set("content", document)
		return result, nil
	}
	if format == "markdown" {
		markdown, err := documentMarkdown(document, args.Get("metadata") == true)
		if err != nil {
			return nil, err
		}
		result.Set("format", format)
		result.Set("content", markdown)
		return result, nil
	}
	depth := option(args, "maxDepth", 6, 0, 20)
	budget := &readBudget{remaining: 2000, unlimited: live}
	nodes := []any{}
	for index, raw := range document.Array("nodes") {
		node := compactNode(document, asObject(raw), []int{index}, nil, depth, budget)
		if node != nil {
			nodes = append(nodes, node)
		}
	}
	content := ordered("id", document.Get("id"), "title", document.Get("title"), "createdAt", document.Get("createdAt"), "updatedAt", document.Get("updatedAt"))
	for _, field := range []string{"markdownUpdatedAt", "attachments"} {
		if document.Has(field) {
			content.Set(field, document.Get(field))
		}
	}
	if document.Get("attachments") != nil {
		content.Set("attachmentAvailability", "unknown")
	}
	content.Set("nodeCount", treeCount(document.Array("nodes")))
	content.Set("topLevelNodeCount", len(document.Array("nodes")))
	content.Set("maxDepth", depth)
	if !live {
		content.Set("maxDocumentNodes", 2000)
	}
	knowledge := knowledgeSummary(workspace, document)
	content.Set("knowledge", knowledge)
	content.Set("truncated", budget.truncated || knowledge.Get("truncated") == true)
	content.Set("nodes", nodes)
	result.Set("format", "compact")
	result.Set("content", content)
	return result, nil
}
func getNode(workspace, args *object, live bool) (*object, error) {
	document, err := documentByID(workspace, args.String("documentId"))
	if err != nil {
		return nil, err
	}
	node, path, parents, err := nodeByID(document, args.String("nodeId"))
	if err != nil {
		return nil, err
	}
	budget := &readBudget{remaining: 2000, unlimited: live}
	root := compactNode(document, node, path, parents, 0, budget)
	ancestors := []any{}
	if args.Get("includeAncestors") != false {
		start := 0
		if !live && len(parents) > budget.remaining {
			start = len(parents) - budget.remaining
			budget.truncated = true
		}
		for index := start; index < len(parents); index++ {
			ancestors = append(ancestors, nodeFields(document, parents[index], path[:index+1], parents[:index]))
			budget.remaining--
		}
	}
	depth := option(args, "childrenDepth", 2, 0, 8)
	children := []any{}
	if root != nil && depth > 0 {
		for index, raw := range node.Array("children") {
			child := compactNode(document, asObject(raw), append(append([]int{}, path...), index), append(append([]*object{}, parents...), node), depth-1, budget)
			if child != nil {
				children = append(children, child)
			} else {
				break
			}
		}
		root.Set("children", children)
	}
	siblings := []any{}
	if args.Get("includeSiblings") == true {
		container := document.Array("nodes")
		if len(parents) > 0 {
			container = parents[len(parents)-1].Array("children")
		}
		for index, raw := range container {
			sibling := asObject(raw)
			if sibling.String("id") == node.String("id") {
				continue
			}
			at := append(append([]int{}, path[:len(path)-1]...), index)
			item := compactNode(document, sibling, at, parents, 0, budget)
			if item != nil {
				siblings = append(siblings, item)
			}
		}
	}
	result := ordered("documentId", document.Get("id"), "documentTitle", document.Get("title"), "format", "compact")
	if !live {
		result.Set("maxDocumentNodes", 2000)
	}
	result.Set("truncated", budget.truncated)
	result.Set("node", root)
	result.Set("ancestors", ancestors)
	result.Set("siblings", siblings)
	return result, nil
}
func filename(title, extension string) string {
	title = contracts.TrimJS(title)
	units := contracts.UTF16(title)
	for index, unit := range units {
		if unit < 32 || strings.ContainsRune("<>:"+string(rune(34))+"/\\|?*", rune(unit)) {
			units[index] = '_'
		}
	}
	title = contracts.CompactWhitespace(contracts.FromUTF16(units))
	title = strings.TrimLeft(title, ".")
	title = strings.TrimRightFunc(title, func(r rune) bool { return r == '.' || r <= 0xffff && contracts.JSWhitespace(uint16(r)) })
	characters := []rune(title)
	if len(characters) > 120 {
		title = string(characters[:120])
	}
	if title == "" {
		title = "未命名文档"
	}
	if regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])$`).MatchString(title) {
		title = "_" + title
	}
	return title + "." + extension
}
func exportDocument(workspace, args *object) (*object, error) {
	document, err := documentByID(workspace, args.String("documentId"))
	if err != nil {
		return nil, err
	}
	if args.String("format") == "markdown" {
		content, err := documentMarkdown(document, args.Get("metadata") == true)
		if err != nil {
			return nil, err
		}
		extension := "md"
		if args.Get("metadata") == true {
			extension = "bike.md"
		}
		return ordered("filename", filename(document.String("title"), extension), "mime", "text/markdown", "content", content), nil
	}
	content, err := contracts.Stringify(document, true, false)
	if err != nil {
		return nil, err
	}
	return ordered("filename", filename(document.String("title"), "json"), "mime", "application/json", "content", string(content)), nil
}
