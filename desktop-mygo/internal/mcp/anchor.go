package mcp

import (
	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"strings"
)

// Anchor only unambiguous, exact source provenance. Existing node-field
// identities and unresolved source groups are retained without retargeting.
func anchorKnowledge(document *object) *object {
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
	sourceLinks := scanWiki(markdown)
	type origin struct {
		nodeID, field string
		start, end    int
	}
	candidates := map[string][]origin{}
	walkNodes(document.Array("nodes"), func(node *object, _ []int, _ []*object) {
		rendered := inlineMarkdown(node.String("text"))
		if strings.Count(markdown, rendered) != 1 {
			return
		}
		for _, field := range []string{"text", "note"} {
			value := node.String(field)
			if field == "note" && !strings.Contains(markdown, markdownNote(value, "")) {
				continue
			}
			for _, link := range scanWiki(value) {
				candidates[link.raw] = append(candidates[link.raw], origin{node.String("id"), field, link.start, link.end})
			}
		}
	})
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
		count := 0
		for _, link := range sourceLinks {
			if link.raw == source.String("raw") {
				count++
			}
		}
		origins := candidates[source.String("raw")]
		if count != 1 || len(origins) != 1 {
			continue
		}
		at := origins[0]
		reference.Set("source", ordered("kind", "node-field", "nodeId", at.nodeID, "field", at.field, "start", float64(at.start), "end", float64(at.end), "raw", source.String("raw")))
	}
	return result
}
