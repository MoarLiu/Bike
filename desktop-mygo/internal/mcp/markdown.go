package mcp

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"regexp"
	"strings"
	"unicode"
)

func inlineMarkdown(value string) string {
	value = contracts.TrimJS(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", " "), "\n", " "))
	if value == "" {
		value = "未命名主题"
	}
	escape := func(value string) string {
		units := contracts.UTF16(value)
		compact := []uint16{}
		space := false
		for _, unit := range units {
			if contracts.JSWhitespace(unit) {
				if !space {
					compact = append(compact, ' ')
				}
				space = true
			} else {
				compact = append(compact, unit)
				space = false
			}
		}
		output := []uint16{}
		for index, unit := range compact {
			reserved := strings.ContainsRune("\\`*_[]{}()#+-.!>", rune(unit))
			if unit == '#' && index+1 < len(compact) {
				next := rune(compact[index+1])
				if unicode.IsLetter(next) || unicode.IsNumber(next) || next == '_' || next == '-' {
					reserved = false
				}
			}
			if reserved {
				output = append(output, '\\')
			}
			output = append(output, unit)
		}
		return contracts.FromUTF16(output)
	}
	output := ""
	cursor := 0
	for _, link := range scanWiki(value) {
		output += escape(contracts.SliceUTF16(value, cursor, link.start)) + link.raw
		cursor = link.end
	}
	return output + escape(contracts.SliceUTF16(value, cursor, contracts.UTF16Length(value)))
}
func plainMarkdownText(value string) string {
	source := inlineMarkdown(value)
	units := contracts.UTF16(source)
	mask := codeMask(units)
	links := scanWiki(source)
	inside := func(at int) bool {
		for _, link := range links {
			if at >= link.start && at < link.end {
				return true
			}
		}
		return false
	}
	output := []uint16{}
	for index := 0; index < len(units); index++ {
		unit := units[index]
		if unit == '\\' && index+1 < len(units) && strings.ContainsRune("\\`*_[]{}()#+-.!>", rune(units[index+1])) && !mask[index] && !inside(index) {
			next := units[index+1]
			preserve := false
			if next == '#' && (index == 0 || contracts.JSWhitespace(units[index-1])) && index+2 < len(units) {
				r := rune(units[index+2])
				preserve = unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' || r == '-'
			}
			at := index
			for at < len(units) && units[at] == '\\' {
				at++
			}
			preserve = preserve || at+1 < len(units) && units[at] == '[' && units[at+1] == '['
			if !preserve {
				output = append(output, next)
				index++
				continue
			}
		}
		output = append(output, unit)
	}
	return contracts.FromUTF16(output)
}
func markdownNote(value, indent string) string {
	lines := strings.Split(normalizedLines(value), "\n")
	for index, line := range lines {
		lines[index] = indent + "> " + line
	}
	return strings.Join(lines, "\n")
}
func markdownCode(value, language, indent string) []string {
	value = normalizedLines(value)
	longest, current := 0, 0
	for _, r := range value {
		if r == '`' {
			current++
			longest = max(longest, current)
		} else {
			current = 0
		}
	}
	fence := strings.Repeat("`", max(3, longest+1))
	language = contracts.TrimJS(language)
	for index, unit := range contracts.UTF16(language) {
		if unit == '`' || unit == '~' || contracts.JSWhitespace(unit) {
			language = contracts.SliceUTF16(language, 0, index)
			break
		}
	}
	lines := []string{indent + fence + language}
	for _, line := range strings.Split(value, "\n") {
		lines = append(lines, indent+line)
	}
	return append(lines, indent+fence)
}
func markdownTable(value []any, indent string) []string {
	rows := [][]string{}
	columns := 0
	for _, raw := range value {
		row, ok := raw.([]any)
		if !ok || len(row) == 0 {
			continue
		}
		cells := []string{}
		for _, cell := range row {
			value := textOr(cell, "")
			if value != "" {
				value = inlineMarkdown(value)
				links := scanWiki(value)
				for index := len(links) - 1; index >= 0; index-- {
					link := links[index]
					value = contracts.SliceUTF16(value, 0, link.start) + strings.ReplaceAll(link.raw, "\\", "\\\\") + contracts.SliceUTF16(value, link.end, contracts.UTF16Length(value))
				}
				value = strings.ReplaceAll(value, "|", "\\|")
			}
			cells = append(cells, value)
		}
		columns = max(columns, len(cells))
		rows = append(rows, cells)
	}
	if len(rows) == 0 {
		return nil
	}
	output := []string{}
	for index, row := range rows {
		for len(row) < columns {
			row = append(row, "")
		}
		output = append(output, indent+"| "+strings.Join(row, " | ")+" |")
		if index == 0 {
			cells := make([]string, columns)
			for at := range cells {
				cells[at] = "---"
			}
			output = append(output, indent+"| "+strings.Join(cells, " | ")+" |")
		}
	}
	return output
}
func renderedMarkdown(document *object) string {
	if source, ok := document.Get("markdownSource").(string); ok {
		return normalizedLines(strings.TrimPrefix(source, "\ufeff"))
	}
	title := document.String("title")
	if title == "" {
		title = "未命名文档"
	}
	lines := []string{"# " + inlineMarkdown(title), ""}
	items := document.Child("attachments").Child("items")
	var render func([]any, int, bool)
	render = func(nodes []any, depth int, inside bool) {
		for _, raw := range nodes {
			node := asObject(raw)
			heading, _ := node.Get("headingLevel").(float64)
			isHeading := heading > 0 && !inside
			indent := strings.Repeat("  ", depth)
			childIndent := indent + "  "
			childDepth, childInside := depth+1, true
			if isHeading {
				lines = append(lines, strings.Repeat("#", min(int(heading)+1, 6))+" "+inlineMarkdown(node.String("text")))
				childIndent = ""
				childDepth, childInside = 0, false
			} else {
				marker := "-"
				if node.Get("isTodo") == true || node.Get("checked") == true {
					check := " "
					if node.Get("checked") == true {
						check = "x"
					}
					marker = "- [" + check + "]"
				}
				lines = append(lines, indent+marker+" "+inlineMarkdown(node.String("text")))
			}
			if node.String("note") != "" {
				lines = append(lines, markdownNote(node.String("note"), childIndent))
			}
			if node.String("imageName") != "" {
				label := node.String("imageAlt")
				if label == "" {
					label = node.String("imageName")
				}
				lines = append(lines, childIndent+"!["+inlineMarkdown(label)+"]("+node.String("imageName")+")")
			}
			for _, rawRef := range node.Array("attachmentRefs") {
				ref := asObject(rawRef)
				metadata := items.Child(ref.String("assetId"))
				marker := ""
				mediaType := metadata.String("mediaType")
				length, _ := metadata.Get("byteLength").(float64)
				width, _ := metadata.Get("width").(float64)
				height, _ := metadata.Get("height").(float64)
				if (mediaType == "image/png" || mediaType == "image/jpeg" || mediaType == "image/webp") && length <= 32*1024*1024 && width > 0 && height > 0 && width*height <= 40000000 {
					marker = "!"
				}
				label := ref.String("name")
				if marker != "" && ref.String("alt") != "" {
					label = ref.String("alt")
				}
				lines = append(lines, childIndent+marker+"["+inlineMarkdown(label)+"](bike-attachment:"+ref.String("assetId")+")")
			}
			if node.Has("table") {
				lines = append(lines, markdownTable(node.Array("table"), childIndent)...)
			}
			if code, ok := node.Get("codeBlock").(string); ok {
				lines = append(lines, markdownCode(code, node.String("codeLanguage"), childIndent)...)
			}
			render(node.Array("children"), childDepth, childInside)
		}
	}
	render(document.Array("nodes"), 0, false)
	return strings.TrimRightFunc(strings.Join(lines, "\n"), func(r rune) bool { return r <= 0xffff && contracts.JSWhitespace(uint16(r)) })
}

const metadataStart = "<!-- bike:metadata -->"
const metadataEnd = "<!-- /bike:metadata -->"
const lossyMarker = "<!-- bike-export:lossy -->"

func canonicalText(value string) string {
	return strings.TrimRightFunc(value, func(r rune) bool { return r <= 0xffff && contracts.JSWhitespace(uint16(r)) })
}
func textDigest(value string) string {
	sum := sha256.Sum256(contracts.TextEncoder(value))
	return hex.EncodeToString(sum[:])
}
func metadataDepth(value any) int {
	maximum := 1
	type item struct {
		value any
		depth int
	}
	pending := []item{{value, 1}}
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		maximum = max(maximum, current.depth)
		if maximum > 8 {
			return maximum
		}
		switch value := current.value.(type) {
		case *object:
			if value != nil {
				for _, key := range value.Keys {
					pending = append(pending, item{value.Get(key), current.depth + 1})
				}
			}
		case []any:
			for _, value := range value {
				pending = append(pending, item{value, current.depth + 1})
			}
		}
	}
	return maximum
}
func metadataComment(document *object, body string) (string, error) {
	knowledge := anchorKnowledge(document)
	if document.Get("knowledge") != nil && !knowledgeEditable(knowledge) {
		return "", fmt.Errorf("当前版本无法无损导出这份知识数据，请使用 JSON 导出保留原数据")
	}
	version := 1
	if document.Has("attachments") {
		version = 2
	}
	attributes := contracts.NewObject()
	for _, key := range document.Keys {
		if key != "id" && key != "title" && key != "nodes" && key != "knowledge" && key != "markdownSource" && key != "markdownUpdatedAt" && key != "updatedAt" {
			attributes.Set(key, document.Get(key))
		}
	}
	nodes := []any{}
	walkNodes(document.Array("nodes"), func(node *object, path []int, _ []*object) {
		attributes := contracts.NewObject()
		for _, key := range node.Keys {
			if key != "id" && key != "text" && key != "note" && key != "children" {
				attributes.Set(key, node.Get(key))
			}
		}
		at := []any{}
		for _, index := range path {
			at = append(at, float64(index))
		}
		nodes = append(nodes, ordered("id", node.Get("id"), "path", at, "text", node.String("text"), "exportText", plainMarkdownText(node.String("text")), "note", node.String("note"), "attributes", attributes))
	})
	payload := ordered("v", version, "documentId", document.Get("id"), "title", document.Get("title"), "documentAttributes", attributes, "structure", "tree-v1", "nodes", nodes)
	if knowledgeEditable(knowledge) {
		payload.Set("knowledge", knowledge)
	}
	payload.Set("digest", textDigest(canonicalText(body)))
	if metadataDepth(payload) > 8 {
		return "", fmt.Errorf("当前数据无法安全编码为 Bike 元数据，请使用 JSON 导出保留原数据")
	}
	encoded, err := contracts.Stringify(payload, false, false)
	if err != nil {
		return "", err
	}
	if len(encoded) > 2*1024*1024 {
		return "", fmt.Errorf("Bike 元数据超过 2 MiB，已取消无损导出")
	}
	return fmt.Sprintf("<!-- bike:document:v%d %s -->", version, base64.RawURLEncoding.EncodeToString(encoded)), nil
}
func stripMetadata(source string) (string, error) {
	source = normalizedLines(strings.TrimPrefix(source, "\ufeff"))
	mask := codeMask(contracts.UTF16(source))
	standalone := func(at int) bool {
		if mask[contracts.UTF16Length(source[:at])] {
			return false
		}
		line := strings.LastIndex(source[:at], "\n") + 1
		prefix := source[line:at]
		return len(prefix) <= 3 && strings.Trim(prefix, " ") == ""
	}
	find := func(pattern string) [][]int {
		matches := regexp.MustCompile(pattern).FindAllStringSubmatchIndex(source, -1)
		result := [][]int{}
		for _, match := range matches {
			if standalone(match[0]) {
				result = append(result, match)
			}
		}
		return result
	}
	starts, ends := find(`(?m)^<!-- bike:metadata -->$`), find(`(?m)^<!-- /bike:metadata -->$`)
	if len(starts) > 0 || len(ends) > 0 {
		if len(starts) != 1 || len(ends) != 1 || starts[0][0] >= ends[0][0] {
			return source, fmt.Errorf("Bike 元数据封装无效或重复")
		}
	}
	matches := find(`<!--` + jsSpaceClass + `*bike:document:v([0-9]+)` + jsSpaceClass + `+([A-Za-z0-9_-]+)` + jsSpaceClass + `*-->`)
	loose := find(`<!--` + jsSpaceClass + `*bike:document:v[0-9]+[^>]*-->`)
	if len(matches) == 0 && len(loose) == 0 {
		if len(starts) > 0 {
			return source, fmt.Errorf("Bike 元数据字段无效")
		}
		return source, nil
	}
	if len(matches) != 1 || len(loose) != 1 {
		return source, fmt.Errorf("Bike 元数据格式无效")
	}
	match := matches[0]
	version := source[match[2]:match[3]]
	if version != "1" && version != "2" {
		return source, fmt.Errorf("原 Markdown 中的 Bike 元数据无法安全更新，请使用 JSON 保留原数据")
	}
	encoded, err := base64.RawURLEncoding.DecodeString(source[match[4]:match[5]])
	if err != nil || len(encoded) > 2*1024*1024 {
		return source, fmt.Errorf("Bike 元数据无法解码或超过预算")
	}
	parsed, err := contracts.ParseJSON(encoded)
	payload := asObject(parsed)
	if err != nil || payload == nil || payload.Get("v") != map[string]float64{"1": 1, "2": 2}[version] || !isString(payload.Get("documentId")) || payload.Array("nodes") == nil || !isString(payload.Get("digest")) || metadataDepth(payload) > 8 || !validMetadataPayload(payload) {
		return source, fmt.Errorf("Bike 元数据字段无效")
	}
	if len(starts) > 0 {
		if match[0] < starts[0][0] || match[0] >= ends[0][0] {
			return source, fmt.Errorf("Bike 元数据字段无效")
		}
		return canonicalText(source[:starts[0][0]] + source[ends[0][1]:]), nil
	}
	return canonicalText(source[:match[0]] + source[match[1]:]), nil
}
func documentMarkdown(document *object, metadata bool) (string, error) {
	original := renderedMarkdown(document)
	body, err := stripMetadata(original)
	if err != nil {
		if metadata {
			return "", err
		}
		return original, nil
	}
	mask := codeMask(contracts.UTF16(body))
	start := 0
	last := -1
	for {
		at := strings.Index(body[start:], lossyMarker)
		if at < 0 {
			break
		}
		at += start
		if !mask[contracts.UTF16Length(body[:at])] {
			last = at
		}
		start = at + len(lossyMarker)
	}
	if last >= 0 {
		body = body[:last]
	}
	body = canonicalText(body)
	if metadata {
		comment, err := metadataComment(document, body)
		if err != nil {
			return "", err
		}
		return body + "\n\n" + metadataStart + "\n" + comment + "\n" + metadataEnd + "\n", nil
	}
	knowledge := document.Child("knowledge")
	if !knowledgeEditable(knowledge) || len(knowledge.Array("references"))+len(knowledge.Array("relations")) == 0 {
		return body, nil
	}
	labels := map[string]string{}
	walkNodes(document.Array("nodes"), func(node *object, _ []int, _ []*object) {
		label := node.String("text")
		if label == "" {
			label = "未命名主题"
		}
		labels[node.String("id")] = label
	})
	lines := []string{"", lossyMarker, "## 关系", ""}
	for _, raw := range knowledge.Array("relations") {
		relation := asObject(raw)
		from, to := labels[relation.String("fromNodeId")], labels[relation.String("toNodeId")]
		if from == "" {
			from = "缺失主题"
		}
		if to == "" {
			to = "缺失主题"
		}
		line := "- " + from + " → " + to
		if relation.String("label") != "" {
			line += "：" + relation.String("label")
		}
		lines = append(lines, line)
	}
	if len(knowledge.Array("relations")) == 0 {
		lines = append(lines, "- （没有跨主题关系）")
	}
	lines = append(lines, "", "> 此 Markdown 不包含稳定 id。链接文字仍可读，但重名和身份信息可能丢失。如需在 Bike 间无损往返，请导出带元数据的 Markdown。", "")
	return body + "\n" + strings.Join(lines, "\n"), nil
}
