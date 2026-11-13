package mcp

import (
	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

// Anchor only unambiguous, exact source provenance. Existing node-field
// identities and unresolved source groups are retained without retargeting.
func anchorKnowledge(document *object) *object {
	return anchorKnowledgeWithOrigins(document, nil)
}
func anchorKnowledgeWithOrigins(document *object, origins map[int]markdownOrigin) *object {
	knowledge := document.Child("knowledge")
	if !knowledgeEditable(knowledge) || !isString(document.Get("markdownSource")) {
		return knowledge
	}
	cloned, err := contracts.Clone(knowledge)
	if err != nil {
		return knowledge
	}
	result := asObject(cloned)
	markdown := document.String("markdownSource")
	if origins == nil {
		origins = markdownOrigins(document)
	}
	for _, raw := range result.Array("references") {
		reference := asObject(raw)
		source := reference.Child("source")
		if source.String("kind") != "markdown" {
			continue
		}
		start, _ := source.Get("start").(float64)
		end, _ := source.Get("end").(float64)
		if start < 0 || contracts.SliceUTF16(markdown, int(start), int(end)) != source.String("raw") {
			source.Set("start", float64(-1))
			source.Set("end", float64(-1))
			continue
		}
		at, found := origins[int(start)]
		if !found {
			continue
		}
		reference.Set("source", ordered("kind", "node-field", "nodeId", at.nodeID, "field", at.field, "start", float64(at.start), "end", float64(at.end), "raw", source.String("raw")))
	}
	return result
}
