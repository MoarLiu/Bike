package mcp

import (
	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
	"math"
	"strings"
)

type wikiLink struct {
	start, end        int
	raw, documentName string
	nodeName, alias   *string
	label             string
}

func escapedUnits(text []uint16, index int) bool {
	slashes := 0
	for cursor := index - 1; cursor >= 0 && text[cursor] == '\\'; cursor-- {
		slashes++
	}
	return slashes%2 == 1
}
func codeMask(text []uint16) []bool {
	mask := make([]bool, len(text))
	marker := uint16(0)
	width := 0
	for start := 0; start < len(text); {
		end := start
		for end < len(text) && text[end] != '\n' {
			end++
		}
		next := end
		if next < len(text) {
			next++
		}
		at := start
		for at < end && (text[at] == ' ' || text[at] == '\t') {
			at++
		}
		run := 0
		var current uint16
		if at < end && (text[at] == '`' || text[at] == '~') {
			current = text[at]
			for at+run < end && text[at+run] == current {
				run++
			}
		}
		if marker != 0 {
			for index := start; index < next; index++ {
				mask[index] = true
			}
			tail := at + run
			for tail < end && (text[tail] == ' ' || text[tail] == '\t') {
				tail++
			}
			if current == marker && run >= width && tail == end {
				marker = 0
				width = 0
			}
		} else if run >= 3 {
			marker, width = current, run
			for index := start; index < next; index++ {
				mask[index] = true
			}
		}
		start = next
	}
	for cursor := 0; cursor < len(text); {
		if mask[cursor] || text[cursor] != '`' || escapedUnits(text, cursor) {
			cursor++
			continue
		}
		end := cursor + 1
		for end < len(text) && text[end] == '`' {
			end++
		}
		width := end - cursor
		close := end
		matched := false
		for close < len(text) && !mask[close] {
			if text[close] != '`' {
				close++
				continue
			}
			runEnd := close + 1
			for runEnd < len(text) && text[runEnd] == '`' {
				runEnd++
			}
			if runEnd-close == width {
				for index := cursor; index < runEnd; index++ {
					mask[index] = true
				}
				cursor = runEnd
				matched = true
				break
			}
			close = runEnd
		}
		if !matched {
			cursor = end
		}
	}
	return mask
}
func scanWiki(value string) []wikiLink {
	text := contracts.UTF16(value)
	mask := codeMask(text)
	links := []wikiLink{}
	reserved := func(unit uint16) bool { return strings.ContainsRune("\\#|][`", rune(unit)) }
	for index := 0; index < len(text)-1; index++ {
		if mask[index] || text[index] != '[' || text[index+1] != '[' || escapedUnits(text, index) {
			continue
		}
		close := -1
		boundary := len(text) - 1
		for cursor := index + 2; cursor < len(text)-1; cursor++ {
			if mask[cursor] {
				boundary = cursor
				break
			}
			if text[cursor] == '\\' && reserved(text[cursor+1]) {
				cursor++
				continue
			}
			if text[cursor] == ']' && text[cursor+1] == ']' && !escapedUnits(text, cursor) {
				close = cursor
				break
			}
		}
		if close < 0 {
			index = max(index, boundary-1)
			continue
		}
		parts := [][]uint16{{}, nil, nil}
		mode := 0
		valid := true
		for cursor := index + 2; cursor < close; cursor++ {
			if mask[cursor] {
				valid = false
				break
			}
			unit := text[cursor]
			if unit == '\\' && cursor+1 < close && reserved(text[cursor+1]) {
				cursor++
				parts[mode] = append(parts[mode], text[cursor])
				continue
			}
			if unit == '#' && mode == 0 {
				mode = 1
				parts[1] = []uint16{}
				continue
			}
			if unit == '|' && mode != 2 {
				mode = 2
				parts[2] = []uint16{}
				continue
			}
			parts[mode] = append(parts[mode], unit)
		}
		name := norm.NFC.String(contracts.FromUTF16(parts[0]))
		if !valid || name == "" || parts[1] != nil && len(parts[1]) == 0 {
			index = close + 1
			continue
		}
		link := wikiLink{start: index, end: close + 2, raw: contracts.FromUTF16(text[index : close+2]), documentName: name, label: name}
		if parts[1] != nil {
			value := norm.NFC.String(contracts.FromUTF16(parts[1]))
			link.nodeName = &value
			link.label = value
		}
		if parts[2] != nil {
			value := norm.NFC.String(contracts.FromUTF16(parts[2]))
			link.alias = &value
			if value != "" {
				link.label = value
			}
		}
		links = append(links, link)
		index = close + 1
	}
	return links
}
func lower(value string) string    { return cases.Lower(language.Und).String(value) }
func identity(value string) string { return norm.NFC.String(value) }
func folded(value string) string   { return lower(identity(value)) }
func integer(value any) bool {
	number, ok := value.(float64)
	return ok && !math.IsInf(number, 0) && number == math.Trunc(number)
}
func isString(value any) bool { _, ok := value.(string); return ok }
func knowledgeEditable(knowledge *object) bool {
	if knowledge == nil || knowledge.Get("version") != float64(1) {
		return false
	}
	references, ok := knowledge.Get("references").([]any)
	if !ok {
		return false
	}
	relations, ok := knowledge.Get("relations").([]any)
	if !ok {
		return false
	}
	for _, raw := range references {
		reference := asObject(raw)
		if reference == nil || !isString(reference.Get("id")) {
			return false
		}
		source, target := reference.Child("source"), reference.Child("target")
		if source == nil || target == nil || !isString(source.Get("raw")) || !integer(source.Get("start")) || !integer(source.Get("end")) || !isString(target.Get("documentId")) || target.Has("nodeId") && !isString(target.Get("nodeId")) {
			return false
		}
		if source.String("kind") != "node-field" && source.String("kind") != "markdown" {
			return false
		}
		if source.String("kind") == "node-field" && (!isString(source.Get("nodeId")) || (source.String("field") != "text" && source.String("field") != "note")) {
			return false
		}
		if reference.String("labelMode") != "auto" && reference.String("labelMode") != "custom" {
			return false
		}
		if source.Has("groupId") && (!isString(source.Get("groupId")) || !knowledge.Child("sourceGroups").Has(source.String("groupId"))) {
			return false
		}
	}
	for _, raw := range relations {
		relation := asObject(raw)
		if relation == nil {
			return false
		}
		for _, field := range []string{"id", "fromNodeId", "toNodeId", "label"} {
			if !isString(relation.Get(field)) {
				return false
			}
		}
	}
	if knowledge.Has("sourceGroups") {
		groups := knowledge.Child("sourceGroups")
		if groups == nil {
			return false
		}
		for _, key := range groups.Keys {
			group := groups.Child(key)
			if group == nil || !isString(group.Get("raw")) {
				return false
			}
			candidates, ok := group.Get("candidates").([]any)
			if !ok {
				return false
			}
			for _, raw := range candidates {
				item := asObject(raw)
				if item == nil || !isString(item.Get("nodeId")) || (item.String("field") != "text" && item.String("field") != "note") {
					return false
				}
			}
		}
	}
	return true
}
func trashDocuments(workspace *object) []*object {
	result := []*object{}
	for _, raw := range workspace.Array("trash") {
		if document := asObject(raw).Child("document"); document != nil {
			result = append(result, document)
		}
	}
	return result
}
func documentsNamed(documents []*object, name string) []*object {
	exact, foldedMatches := []*object{}, []*object{}
	for _, document := range documents {
		if identity(document.String("title")) == identity(name) {
			exact = append(exact, document)
		}
		if folded(document.String("title")) == folded(name) {
			foldedMatches = append(foldedMatches, document)
		}
	}
	if len(exact) > 0 {
		return exact
	}
	return foldedMatches
}
func liveDocuments(workspace *object) []*object {
	result := []*object{}
	for _, raw := range workspace.Array("documents") {
		result = append(result, asObject(raw))
	}
	return result
}
func nodesNamed(document *object, name string) []*object {
	exact, foldedMatches := []*object{}, []*object{}
	walkNodes(document.Array("nodes"), func(node *object, _ []int, _ []*object) {
		if identity(node.String("text")) == identity(name) {
			exact = append(exact, node)
		}
		if folded(node.String("text")) == folded(name) {
			foldedMatches = append(foldedMatches, node)
		}
	})
	if len(exact) > 0 {
		return exact
	}
	return foldedMatches
}
func resolveLink(workspace *object, link wikiLink) (string, string, any) {
	documents := documentsNamed(liveDocuments(workspace), link.documentName)
	if len(documents) != 1 {
		trashed := documentsNamed(trashDocuments(workspace), link.documentName)
		if len(documents) == 0 && len(trashed) == 1 && link.nodeName == nil {
			return "deleted", trashed[0].String("id"), nil
		}
		if len(documents) > 0 {
			return "ambiguous", "", nil
		}
		if len(trashed) > 0 {
			return "deleted", "", nil
		}
		return "missing", "", nil
	}
	document := documents[0]
	if link.nodeName == nil {
		return "resolved", document.String("id"), nil
	}
	nodes := nodesNamed(document, *link.nodeName)
	if len(nodes) == 1 {
		return "resolved", document.String("id"), nodes[0].Get("id")
	}
	if len(nodes) > 0 {
		return "ambiguous", document.String("id"), nil
	}
	for _, trashed := range trashDocuments(workspace) {
		if trashed.String("id") == document.String("id") && len(nodesNamed(trashed, *link.nodeName)) > 0 {
			return "deleted", document.String("id"), nil
		}
	}
	return "missing", document.String("id"), nil
}

type connection struct {
	status, raw, label, documentID, field string
	nodeID                                any
	target                                *object
	resolvedDocument                      string
	resolvedNode                          any
}

func sourceKey(source *object) string {
	if source.String("kind") == "markdown" {
		return "markdown"
	}
	return source.String("kind") + ":" + source.String("nodeId") + ":" + source.String("field")
}
func referenceStatus(workspace, document, reference *object, lookup func(*object, string) *object) string {
	source, target := reference.Child("source"), reference.Child("target")
	value := document.String("markdownSource")
	if source.String("kind") != "markdown" {
		node := lookup(document, source.String("nodeId"))
		value = node.String(source.String("field"))
	}
	start, _ := source.Get("start").(float64)
	end, _ := source.Get("end").(float64)
	if start < 0 || contracts.SliceUTF16(value, int(start), int(end)) != source.String("raw") {
		return "sourceMismatch"
	}
	dest, err := documentByID(workspace, target.String("documentId"))
	var trashed *object
	for _, item := range trashDocuments(workspace) {
		if item.String("id") == target.String("documentId") {
			trashed = item
		}
	}
	if err != nil {
		if trashed != nil {
			return "deleted"
		}
		return "missing"
	}
	if target.String("nodeId") != "" {
		if lookup(dest, target.String("nodeId")) == nil {
			if trashed != nil {
				if lookup(trashed, target.String("nodeId")) != nil {
					return "deleted"
				}
			}
			return "missing"
		}
	}
	return "resolved"
}
func connections(workspace, document *object) []connection {
	origins := map[int]markdownOrigin{}
	if document.Has("markdownSource") {
		origins = markdownOrigins(document)
	}
	knowledge := anchorKnowledgeWithOrigins(document, origins)
	if document.Has("knowledge") && document.Get("knowledge") != nil && !knowledgeEditable(knowledge) {
		return []connection{}
	}
	fields := map[string][]*object{}
	guarded := map[string]map[string]bool{}
	visited := map[*object]bool{}
	result := []connection{}
	nodeMaps := map[*object]map[string]*object{}
	lookup := func(document *object, id string) *object {
		if document == nil {
			return nil
		}
		index, ok := nodeMaps[document]
		if !ok {
			index = map[string]*object{}
			stack := append([]any{}, document.Array("nodes")...)
			for len(stack) > 0 {
				node := asObject(stack[len(stack)-1])
				stack = stack[:len(stack)-1]
				index[node.String("id")] = node
				stack = append(stack, node.Array("children")...)
			}
			nodeMaps[document] = index
		}
		return index[id]
	}
	statuses := map[*object]string{}
	statusFor := func(reference *object) string {
		if status, ok := statuses[reference]; ok {
			return status
		}
		status := referenceStatus(workspace, document, reference, lookup)
		statuses[reference] = status
		return status
	}
	guard := func(key, raw string) {
		if guarded[key] == nil {
			guarded[key] = map[string]bool{}
		}
		guarded[key][raw] = true
	}
	for _, raw := range knowledge.Array("references") {
		reference := asObject(raw)
		source := reference.Child("source")
		key := sourceKey(source)
		fields[key] = append(fields[key], reference)
		if statusFor(reference) == "sourceMismatch" {
			guard(key, source.String("raw"))
			if group := knowledge.Child("sourceGroups").Child(source.String("groupId")); group != nil {
				for _, raw := range group.Array("candidates") {
					item := asObject(raw)
					guard("node-field:"+item.String("nodeId")+":"+item.String("field"), group.String("raw"))
				}
			}
		}
	}
	consume := func(value, kind, field string, nodeID any, skip map[int]bool) {
		origin := ordered("kind", kind, "field", field, "nodeId", nodeID)
		key := sourceKey(origin)
		links := scanWiki(value)
		used := map[int]bool{}
		for _, reference := range fields[key] {
			visited[reference] = true
			source := reference.Child("source")
			label := ""
			for index, link := range links {
				if !used[index] && source.Get("start") == float64(link.start) && source.Get("end") == float64(link.end) && source.String("raw") == link.raw {
					used[index] = true
					label = link.label
					break
				}
			}
			result = append(result, connection{status: statusFor(reference), raw: source.String("raw"), label: label, documentID: document.String("id"), field: field, nodeID: nodeID, target: reference.Child("target")})
		}
		for index, link := range links {
			if used[index] || guarded[key][link.raw] || skip[link.start] {
				continue
			}
			status, documentID, resolvedNode := resolveLink(workspace, link)
			result = append(result, connection{status: status, raw: link.raw, label: link.label, documentID: document.String("id"), field: field, nodeID: nodeID, resolvedDocument: documentID, resolvedNode: resolvedNode})
		}
	}
	walkNodes(document.Array("nodes"), func(node *object, _ []int, _ []*object) {
		for _, field := range []string{"text", "note"} {
			consume(node.String(field), "node-field", field, node.Get("id"), nil)
		}
	})
	if document.Has("markdownSource") {
		skip := map[int]bool{}
		for at := range origins {
			skip[at] = true
		}
		consume(document.String("markdownSource"), "markdown", "markdown", nil, skip)
	}
	for _, raw := range knowledge.Array("references") {
		reference := asObject(raw)
		if visited[reference] {
			continue
		}
		source := reference.Child("source")
		field := source.String("field")
		if field == "" {
			field = "markdown"
		}
		result = append(result, connection{status: statusFor(reference), raw: source.String("raw"), documentID: document.String("id"), field: field, nodeID: source.Get("nodeId"), target: reference.Child("target")})
	}
	return result
}
func knowledgeSummary(workspace, document *object) *object {
	bounded := func(items []any) *object {
		return ordered("items", items[:min(40, len(items))], "total", len(items), "truncated", len(items) > 40)
	}
	references, incoming, relations := []any{}, []any{}, []any{}
	groups := map[string]*object{}
	for _, source := range liveDocuments(workspace) {
		for _, item := range connections(workspace, source) {
			if source == document {
				var field any = item.field
				if field == "" {
					field = nil
				}
				references = append(references, ordered("status", item.status, "raw", item.raw, "target", item.target, "field", field))
			}
			destination := item.resolvedDocument
			if item.target != nil {
				destination = item.target.String("documentId")
			}
			if item.status != "resolved" || destination != document.String("id") {
				continue
			}
			nodeID := textOr(item.nodeID, "")
			key := source.String("id") + "\x00" + nodeID + "\x00" + item.field
			group := groups[key]
			if group == nil {
				group = ordered("documentId", source.String("id"), "documentTitle", source.String("title"), "nodeId", item.nodeID, "field", item.field, "raw", item.raw, "label", item.label, "status", item.status, "count", float64(0))
				groups[key] = group
				incoming = append(incoming, group)
			}
			group.Set("count", group.Get("count").(float64)+1)
		}
	}
	knowledge := document.Child("knowledge")
	if knowledgeEditable(knowledge) {
		for _, raw := range knowledge.Array("relations") {
			relation := asObject(raw)
			_, _, _, from := nodeByID(document, relation.String("fromNodeId"))
			_, _, _, to := nodeByID(document, relation.String("toNodeId"))
			relations = append(relations, ordered("id", relation.Get("id"), "fromNodeId", relation.Get("fromNodeId"), "toNodeId", relation.Get("toNodeId"), "label", relation.Get("label"), "broken", from != nil || to != nil))
		}
	}
	return ordered("references", bounded(references), "incoming", bounded(incoming), "relations", bounded(relations), "truncated", len(references) > 40 || len(incoming) > 40 || len(relations) > 40)
}
