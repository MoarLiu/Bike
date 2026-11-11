package mcp

import (
	"math"
	"sort"
	"strings"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

func truthy(value any) bool {
	switch item := value.(type) {
	case nil:
		return false
	case bool:
		return item
	case string:
		return item != ""
	case float64:
		return item != 0 && !math.IsNaN(item)
	case *object:
		return item != nil
	default:
		return true
	}
}

type fieldEdit struct {
	start, end             int
	previous, next         string
	reference              *object
	resultStart, resultEnd int
}

func sourceNumber(source *object, key string) int {
	number, _ := source.Get(key).(float64)
	return int(number)
}
func applyFieldEdits(text string, edits []*fieldEdit, references []*object) (string, bool) {
	sort.SliceStable(edits, func(i, j int) bool { return edits[i].start < edits[j].start })
	cursor := 0
	output := ""
	length := contracts.UTF16Length(text)
	for _, edit := range edits {
		if edit.start < cursor || edit.end > length || contracts.SliceUTF16(text, edit.start, edit.end) != edit.previous {
			return text, false
		}
		output += contracts.SliceUTF16(text, cursor, edit.start) + edit.next
		edit.resultEnd = contracts.UTF16Length(output)
		edit.resultStart = edit.resultEnd - contracts.UTF16Length(edit.next)
		cursor = edit.end
	}
	output += contracts.SliceUTF16(text, cursor, length)
	for _, reference := range references {
		source := reference.Child("source")
		var covering *fieldEdit
		for _, edit := range edits {
			if edit.reference == reference {
				covering = edit
				break
			}
		}
		if covering != nil {
			source.Set("start", float64(covering.resultStart))
			source.Set("end", float64(covering.resultEnd))
			source.Set("raw", covering.next)
			continue
		}
		delta := 0
		overlap := false
		start, end := sourceNumber(source, "start"), sourceNumber(source, "end")
		for _, edit := range edits {
			if edit.end <= start {
				delta += contracts.UTF16Length(edit.next) - (edit.end - edit.start)
			} else if edit.start < end {
				overlap = true
			}
		}
		if overlap || start < 0 {
			source.Set("start", float64(-1))
			source.Set("end", float64(-1))
		} else {
			source.Set("start", float64(start+delta))
			source.Set("end", float64(end+delta))
		}
	}
	return output, true
}
func referencesForField(document *object, nodeID, field string) []*object {
	knowledge := document.Child("knowledge")
	result := []*object{}
	if !knowledgeEditable(knowledge) {
		return result
	}
	for _, raw := range knowledge.Array("references") {
		reference := asObject(raw)
		source := reference.Child("source")
		matches := source.String("kind") == "node-field" && source.String("nodeId") == nodeID && source.String("field") == field
		group := knowledge.Child("sourceGroups").Child(source.String("groupId"))
		for _, raw := range group.Array("candidates") {
			candidate := asObject(raw)
			matches = matches || candidate.String("nodeId") == nodeID && candidate.String("field") == field
		}
		if matches {
			result = append(result, reference)
		}
	}
	return result
}
func formatWiki(documentName string, nodeName, alias *string) string {
	escape := func(value string) string {
		output := []uint16{}
		for _, unit := range contracts.UTF16(identity(value)) {
			if strings.ContainsRune("\\#|]`", rune(unit)) {
				output = append(output, '\\')
			}
			output = append(output, unit)
		}
		return contracts.FromUTF16(output)
	}
	body := escape(documentName)
	if nodeName != nil && *nodeName != "" {
		body += "#" + escape(*nodeName)
	}
	if alias != nil && *alias != "" {
		body += "|" + escape(*alias)
	}
	return "[[" + body + "]]"
}
func rewrittenLink(link wikiLink, documentID, nodeID, newLabel string) string {
	name := link.documentName
	node := link.nodeName
	if nodeID == "" {
		name = newLabel
	} else {
		node = &newLabel
	}
	return formatWiki(name, node, link.alias)
}
func rewriteField(document, node *object, field string, before *object, documentID, nodeID, newLabel string) bool {
	text := node.String(field)
	links := scanWiki(text)
	if len(links) == 0 {
		return false
	}
	references := referencesForField(document, node.String("id"), field)
	covered := map[int]bool{}
	edits := []*fieldEdit{}
	for _, reference := range references {
		source, target := reference.Child("source"), reference.Child("target")
		index := -1
		for at, link := range links {
			if sourceNumber(source, "start") == link.start && sourceNumber(source, "end") == link.end && source.String("raw") == link.raw {
				index = at
				covered[at] = true
				break
			}
		}
		if index < 0 || reference.String("labelMode") != "auto" || target.String("documentId") != documentID || nodeID != "" && target.String("nodeId") != nodeID {
			continue
		}
		link := links[index]
		next := rewrittenLink(link, documentID, nodeID, newLabel)
		if next != link.raw {
			edits = append(edits, &fieldEdit{start: link.start, end: link.end, previous: link.raw, next: next, reference: reference})
		}
	}
	for index, link := range links {
		if covered[index] || link.alias != nil && *link.alias != "" {
			continue
		}
		guarded := false
		for _, reference := range references {
			source := reference.Child("source")
			if source.String("raw") != link.raw {
				continue
			}
			found := false
			for _, candidate := range links {
				found = found || sourceNumber(source, "start") == candidate.start && sourceNumber(source, "end") == candidate.end && source.String("raw") == candidate.raw
			}
			guarded = guarded || !found
		}
		if guarded {
			continue
		}
		status, destination, target := resolveLink(before, link)
		if status != "resolved" || destination != documentID || nodeID != "" && target != nodeID || nodeID != "" && link.nodeName == nil {
			continue
		}
		next := rewrittenLink(link, documentID, nodeID, newLabel)
		if next != link.raw {
			edits = append(edits, &fieldEdit{start: link.start, end: link.end, previous: link.raw, next: next})
		}
	}
	if len(edits) == 0 {
		return false
	}
	next, ok := applyFieldEdits(text, edits, references)
	if !ok {
		return false
	}
	node.Set(field, next)
	return true
}
func relocateReferences(document *object, nodeID, field, previous, text string) {
	knowledge := document.Child("knowledge")
	if !knowledgeEditable(knowledge) {
		return
	}
	links, oldLinks := scanWiki(text), scanWiki(previous)
	used := map[int]bool{}
	a, b := contracts.UTF16(previous), contracts.UTF16(text)
	prefix, suffix := 0, 0
	for prefix < min(len(a), len(b)) && a[prefix] == b[prefix] {
		prefix++
	}
	for suffix < min(len(a), len(b))-prefix && a[len(a)-suffix-1] == b[len(b)-suffix-1] {
		suffix++
	}
	references := []any{}
	for _, raw := range knowledge.Array("references") {
		reference := asObject(raw)
		source := reference.Child("source")
		if source.String("kind") != "node-field" || source.String("nodeId") != nodeID || source.String("field") != field {
			references = append(references, reference)
			continue
		}
		rawLink := source.String("raw")
		oldCount, newCount := 0, 0
		for _, link := range oldLinks {
			if link.raw == rawLink {
				oldCount++
			}
		}
		for _, link := range links {
			if link.raw == rawLink {
				newCount++
			}
		}
		start, end := sourceNumber(source, "start"), sourceNumber(source, "end")
		if oldCount > 1 && newCount > 0 && oldCount != newCount {
			source.Set("start", float64(-1))
			source.Set("end", float64(-1))
			references = append(references, reference)
			continue
		}
		if start < 0 && newCount > 0 {
			references = append(references, reference)
			continue
		}
		projected := start
		if contracts.SliceUTF16(previous, start, end) == rawLink {
			if start >= len(a)-suffix {
				projected += len(b) - len(a)
			} else if end > prefix {
				projected = -1
			}
		}
		chosen := -1
		matches := []int{}
		for index, link := range links {
			if used[index] || link.raw != rawLink {
				continue
			}
			matches = append(matches, index)
			if link.start == projected {
				chosen = index
			}
		}
		if chosen < 0 && len(matches) == 1 {
			chosen = matches[0]
		}
		if chosen < 0 {
			if len(matches) > 1 {
				source.Set("start", float64(-1))
				source.Set("end", float64(-1))
				references = append(references, reference)
			}
			continue
		}
		used[chosen] = true
		source.Set("start", float64(links[chosen].start))
		source.Set("end", float64(links[chosen].end))
		source.Set("raw", links[chosen].raw)
		references = append(references, reference)
	}
	knowledge.Set("references", references)
}
func renameWorkspace(workspace *object, documentID, nodeID, newLabel string) ([]string, error) {
	document, err := documentByID(workspace, documentID)
	if err != nil {
		return nil, err
	}
	previous := document.String("title")
	var target *object
	if nodeID != "" {
		target, _, _, err = nodeByID(document, nodeID)
		if err != nil {
			return nil, err
		}
		previous = target.String("text")
	}
	if previous == newLabel {
		return []string{}, nil
	}
	cloned, err := contracts.Clone(workspace)
	if err != nil {
		return nil, err
	}
	before := asObject(cloned)
	original := map[string]any{}
	presence := map[string]bool{}
	for _, candidate := range liveDocuments(workspace) {
		id := candidate.String("id")
		original[id], presence[id] = candidate.Get("knowledge"), candidate.Has("knowledge")
		if candidate.Child("knowledge") != nil {
			candidate.Set("knowledge", anchorKnowledge(candidate))
		}
	}
	if target != nil {
		target.Set("text", newLabel)
		relocateReferences(document, nodeID, "text", previous, newLabel)
	} else {
		document.Set("title", newLabel)
	}
	updated := []string{documentID}
	seen := map[string]bool{documentID: true}
	for _, candidate := range liveDocuments(workspace) {
		if truthy(candidate.Get("knowledge")) && !knowledgeEditable(candidate.Child("knowledge")) {
			continue
		}
		changed := false
		walkNodes(candidate.Array("nodes"), func(node *object, _ []int, _ []*object) {
			if candidate.String("id") != documentID || node.String("id") != nodeID {
				changed = rewriteField(candidate, node, "text", before, documentID, nodeID, newLabel) || changed
			}
			changed = rewriteField(candidate, node, "note", before, documentID, nodeID, newLabel) || changed
		})
		if source, ok := candidate.Get("markdownSource").(string); ok {
			links := scanWiki(source)
			references := []*object{}
			knowledge := candidate.Child("knowledge")
			if knowledgeEditable(knowledge) {
				for _, raw := range knowledge.Array("references") {
					reference := asObject(raw)
					if reference.Child("source").String("kind") == "markdown" {
						references = append(references, reference)
					}
				}
			}
			edits := []*fieldEdit{}
			covered := map[int]bool{}
			for _, reference := range references {
				where, destination := reference.Child("source"), reference.Child("target")
				for index, link := range links {
					if sourceNumber(where, "start") != link.start || sourceNumber(where, "end") != link.end || where.String("raw") != link.raw {
						continue
					}
					covered[index] = true
					if reference.String("labelMode") == "auto" && destination.String("documentId") == documentID && (nodeID == "" || destination.String("nodeId") == nodeID) {
						next := rewrittenLink(link, documentID, nodeID, newLabel)
						if next != link.raw {
							edits = append(edits, &fieldEdit{start: link.start, end: link.end, previous: link.raw, next: next, reference: reference})
						}
					}
				}
			}
			for index, link := range links {
				if covered[index] || link.alias != nil && *link.alias != "" {
					continue
				}
				guarded := false
				if knowledgeEditable(knowledge) {
					for _, raw := range knowledge.Array("references") {
						reference := asObject(raw)
						where := reference.Child("source")
						if where.String("raw") == link.raw && (where.String("kind") == "node-field" || sourceNumber(where, "start") < 0) {
							guarded = true
						}
					}
				}
				if guarded {
					continue
				}
				status, destination, targetID := resolveLink(before, link)
				if status != "resolved" || destination != documentID || nodeID != "" && targetID != nodeID {
					continue
				}
				next := rewrittenLink(link, documentID, nodeID, newLabel)
				if next != link.raw {
					edits = append(edits, &fieldEdit{start: link.start, end: link.end, previous: link.raw, next: next})
				}
			}
			if len(edits) > 0 {
				if next, ok := applyFieldEdits(source, edits, references); ok {
					candidate.Set("markdownSource", next)
					changed = true
				}
			}
		}
		id := candidate.String("id")
		if changed && !seen[id] {
			updated = append(updated, id)
			seen[id] = true
		}
	}
	for _, candidate := range liveDocuments(workspace) {
		id := candidate.String("id")
		if !seen[id] {
			if presence[id] {
				candidate.Set("knowledge", original[id])
			} else {
				candidate.Delete("knowledge")
			}
		}
	}
	return updated, nil
}
