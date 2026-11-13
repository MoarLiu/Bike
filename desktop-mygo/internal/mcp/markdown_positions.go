package mcp

import (
	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"regexp"
	"strings"
	"unicode"
)

const jsSpaceClass = `[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var sourceHeading = regexp.MustCompile(`^` + jsSpaceClass + `{0,3}(#{1,6})` + jsSpaceClass + `+(.*?)` + jsSpaceClass + `*$`)
var sourceList = regexp.MustCompile(`^([ \t]*)(?:[-*+]|[0-9]+[.)])` + jsSpaceClass + `+(?:\[(?: |x|X)\]` + jsSpaceClass + `*)?(.*)$`)
var sourceQuote = regexp.MustCompile(`^[ \t]*>` + jsSpaceClass + `?(.*)$`)
var sourceFence = regexp.MustCompile("^([ \\t]*)(`{3,}|~{3,})" + jsSpaceClass + "*(.*)$")
var sourceImage = regexp.MustCompile(`^[ \t]*!\[([^\]]*)\]\(([^)]+)\)` + jsSpaceClass + `*$`)
var sourceManaged = regexp.MustCompile(`^[ \t]*(!?)\[((?:\\.|[^\]\\])*)\]\(bike-attachment:(sha256:[a-f0-9]{64})\)` + jsSpaceClass + `*$`)
var headingSuffix = regexp.MustCompile(jsSpaceClass + `+#+` + jsSpaceClass + `*$`)

type sourceNode struct {
	text, note string
	heading    int
	children   []*sourceNode
	original   *object
}
type sourceField struct {
	node                   *sourceNode
	field                  string
	start, end, fieldStart int
}
type markdownOrigin struct {
	nodeID, field string
	start, end    int
}

func unescapeSourceInline(value string) string {
	// plainMarkdownText uses this same escape policy after export escaping.
	units, mask, links := contracts.UTF16(value), codeMask(contracts.UTF16(value)), scanWiki(value)
	result := []uint16{}
	for index := 0; index < len(units); index++ {
		unit := units[index]
		if unit == '\\' && index+1 < len(units) && strings.ContainsRune("\\`*_[]{}()#+-.!>", rune(units[index+1])) {
			keep := mask[index]
			for _, link := range links {
				if index >= link.start && index < link.end {
					keep = true
					break
				}
			}
			next := index
			for next < len(units) && units[next] == '\\' {
				next++
			}
			keep = keep || next+1 < len(units) && units[next] == '[' && units[next+1] == '['
			if units[index+1] == '#' && (index == 0 || contracts.JSWhitespace(units[index-1])) && index+2 < len(units) {
				next := rune(units[index+2])
				keep = keep || unicode.IsLetter(next) || unicode.IsNumber(next) || next == '_' || next == '-'
			}
			if !keep {
				index++
				unit = units[index]
			}
		}
		result = append(result, unit)
	}
	return contracts.FromUTF16(result)
}

// Source ownership follows the block parser, not text occurrence counts.
// Duplicate labels and repeated links are distinguished by their block ranges.
func markdownOrigins(document *object) map[int]markdownOrigin {
	original := contracts.UTF16(document.String("markdownSource"))
	normalized, originalAt := []uint16{}, []int{}
	for index := 0; index < len(original); index++ {
		if index == 0 && original[index] == 0xfeff {
			continue
		}
		originalAt = append(originalAt, index)
		unit := original[index]
		if unit == '\r' {
			unit = '\n'
			if index+1 < len(original) && original[index+1] == '\n' {
				index++
			}
		}
		normalized = append(normalized, unit)
	}
	originalAt = append(originalAt, len(original))
	source := contracts.FromUTF16(normalized)
	lines, offsets := strings.Split(source, "\n"), []int{}
	offset := 0
	for _, line := range lines {
		offsets = append(offsets, offset)
		offset += contracts.UTF16Length(line) + 1
	}
	mask := codeMask(normalized)
	type frame struct {
		node  *sourceNode
		level int
	}
	headings, lists, roots, fields := []frame{}, []frame{}, []*sourceNode{}, []sourceField{}
	var last *sourceNode
	add := func(node *sourceNode) {
		if len(lists) > 0 {
			parent := lists[len(lists)-1].node
			parent.children = append(parent.children, node)
		} else if len(headings) > 0 {
			parent := headings[len(headings)-1].node
			parent.children = append(parent.children, node)
		} else {
			roots = append(roots, node)
		}
		last = node
	}
	newNode := func(text string, heading int) *sourceNode {
		text = contracts.TrimJS(text)
		if text == "" {
			text = "未命名主题"
		}
		return &sourceNode{text: text, heading: heading}
	}
	capture := func(node *sourceNode, field string, start, end, fieldStart int) {
		fields = append(fields, sourceField{node, field, offsets[start], offsets[end] + contracts.UTF16Length(lines[end]), fieldStart})
	}
	indent := func(value string) int { return len(strings.ReplaceAll(value, "\t", "    ")) }
	cells := func(line string) []string {
		line = contracts.TrimJS(line)
		line = strings.TrimPrefix(line, "|")
		line = strings.TrimSuffix(line, "|")
		output := []string{}
		var cell strings.Builder
		for index := 0; index < len(line); index++ {
			if line[index] == '\\' && index+1 < len(line) && (line[index+1] == '|' || line[index+1] == '\\') {
				index++
				cell.WriteByte(line[index])
				continue
			}
			if line[index] == '|' {
				output = append(output, contracts.TrimJS(cell.String()))
				cell.Reset()
				continue
			}
			cell.WriteByte(line[index])
		}
		return append(output, contracts.TrimJS(cell.String()))
	}
	tableStart := func(index int) bool {
		if index+1 >= len(lines) || !strings.Contains(lines[index], "|") {
			return false
		}
		for _, cell := range cells(lines[index+1]) {
			if !regexp.MustCompile(`^:?-{3,}:?$`).MatchString(contracts.TrimJS(cell)) {
				return false
			}
		}
		return true
	}
	special := func(index int) bool {
		line := lines[index]
		return contracts.TrimJS(line) == "" || sourceHeading.MatchString(line) || sourceList.MatchString(line) || sourceQuote.MatchString(line) || sourceFence.MatchString(line) || sourceImage.MatchString(line) || sourceManaged.MatchString(line) || tableStart(index)
	}
	hasTitle := false
	for index := 0; index < len(lines); {
		line := lines[index]
		if contracts.TrimJS(line) == "" {
			index++
			continue
		}
		if match := sourceHeading.FindStringSubmatch(line); match != nil {
			level := len(match[1])
			text := unescapeSourceInline(contracts.TrimJS(headingSuffix.ReplaceAllString(match[2], "")))
			if level == 1 && !hasTitle && text != "" {
				hasTitle = true
				index++
				continue
			}
			for len(headings) > 0 && headings[len(headings)-1].level >= level {
				headings = headings[:len(headings)-1]
			}
			lists = nil
			node := newNode(text, min(3, max(1, level-1)))
			add(node)
			capture(node, "text", index, index, 0)
			headings = append(headings, frame{node, level})
			index++
			continue
		}
		if match := sourceList.FindStringSubmatch(line); match != nil {
			start := index
			text := contracts.TrimJS(match[2])
			depth := indent(match[1])
			for index+1 < len(lines) && offsets[index]+contracts.UTF16Length(lines[index]) < len(mask) && mask[offsets[index]+contracts.UTF16Length(lines[index])] {
				index++
				text += "\n" + contracts.TrimJS(lines[index])
			}
			for len(lists) > 0 && lists[len(lists)-1].level >= depth {
				lists = lists[:len(lists)-1]
			}
			node := newNode(unescapeSourceInline(text), 0)
			add(node)
			capture(node, "text", start, index, 0)
			lists = append(lists, frame{node, depth})
			index++
			continue
		}
		if sourceQuote.MatchString(line) {
			start := index
			notes := []string{}
			for index < len(lines) {
				match := sourceQuote.FindStringSubmatch(lines[index])
				if match == nil {
					break
				}
				notes = append(notes, match[1])
				index++
			}
			note := contracts.TrimJS(strings.Join(notes, "\n"))
			if last == nil {
				lists = nil
				add(newNode("引用："+strings.Split(note, "\n")[0], 0))
			}
			if note != "" {
				if last.note != "" {
					last.note += "\n\n"
				}
				last.note += note
			}
			capture(last, "note", start, index-1, contracts.UTF16Length(last.note)-contracts.UTF16Length(note))
			continue
		}
		if match := sourceFence.FindStringSubmatch(line); match != nil {
			index++
			for index < len(lines) && !strings.HasPrefix(strings.TrimLeft(lines[index], " \t"), match[2]) {
				index++
			}
			if index < len(lines) {
				index++
			}
			if len(lists) == 0 || last == nil {
				lists = nil
				label := "代码块"
				if lang := contracts.TrimJS(match[3]); lang != "" {
					label += "：" + lang
				}
				add(newNode(label, 0))
			}
			continue
		}
		if tableStart(index) {
			header := cells(line)
			if last == nil {
				lists = nil
				names := []string{}
				for _, cell := range header {
					if text := unescapeSourceInline(contracts.TrimJS(cell)); text != "" {
						names = append(names, text)
					}
				}
				title := strings.Join(names, " / ")
				if title == "" {
					title = "表格"
				}
				add(newNode("表格："+title, 0))
			}
			framed := strings.HasPrefix(contracts.TrimJS(line), "|")
			index += 2
			for index < len(lines) && strings.Contains(lines[index], "|") && contracts.TrimJS(lines[index]) != "" && (!framed || strings.HasPrefix(contracts.TrimJS(lines[index]), "|")) && !sourceHeading.MatchString(lines[index]) && !sourceList.MatchString(lines[index]) && !sourceQuote.MatchString(lines[index]) {
				index++
			}
			continue
		}
		if match := sourceManaged.FindStringSubmatch(line); match != nil {
			if document.Child("attachments").Child("items").Has(match[3]) {
				if last == nil {
					lists = nil
					label := unescapeSourceInline(match[2])
					if label == "" {
						label = "附件"
					}
					add(newNode(label, 0))
				}
				index++
				continue
			}
			if match[1] == "" {
				lists = nil
				add(newNode(unescapeSourceInline(contracts.TrimJS(line)), 0))
				index++
				continue
			}
		}
		if match := sourceImage.FindStringSubmatch(line); match != nil {
			if last == nil {
				lists = nil
				label := unescapeSourceInline(match[1])
				if label == "" {
					label = match[2]
				}
				add(newNode("图片："+label, 0))
				last.note = match[2]
			}
			index++
			continue
		}
		start := index
		parts := []string{}
		for index < len(lines) && !special(index) {
			parts = append(parts, contracts.TrimJS(lines[index]))
			index++
		}
		if index == start {
			index++
			continue
		}
		text := unescapeSourceInline(contracts.TrimJS(strings.Join(parts, " ")))
		if text == "" {
			continue
		}
		leading := lines[start][:len(lines[start])-len(strings.TrimLeft(lines[start], " \t"))]
		if len(lists) > 0 && indent(leading) > lists[len(lists)-1].level && last != nil {
			if last.note != "" {
				last.note += "\n"
			}
			last.note += text
			capture(last, "note", start, index-1, contracts.UTF16Length(last.note)-contracts.UTF16Length(text))
		} else {
			lists = nil
			node := newNode(text, 0)
			add(node)
			capture(node, "text", start, index-1, 0)
		}
	}
	oldGroups, newGroups := map[string][]*object{}, map[string][]*sourceNode{}
	key := func(text string) string { return lower(contracts.CompactWhitespace(unescapeSourceInline(text))) }
	walkNodes(document.Array("nodes"), func(node *object, _ []int, _ []*object) {
		k := key(node.String("text"))
		oldGroups[k] = append(oldGroups[k], node)
	})
	var flatten func([]*sourceNode)
	flatten = func(nodes []*sourceNode) {
		for _, node := range nodes {
			k := key(node.text)
			newGroups[k] = append(newGroups[k], node)
			flatten(node.children)
		}
	}
	flatten(roots)
	used := map[*object]bool{}
	for k, nodes := range newGroups {
		if k != "" && len(nodes) == 1 && len(oldGroups[k]) == 1 {
			nodes[0].original = oldGroups[k][0]
			used[oldGroups[k][0]] = true
		}
	}
	var align func([]any, []*sourceNode)
	align = func(before []any, after []*sourceNode) {
		for index, node := range after {
			if node.original == nil && index < len(before) {
				old := asObject(before[index])
				if !used[old] && old.String("text") == node.text {
					node.original = old
					used[old] = true
				}
			}
		}
		oldGap, newGap := []*object{}, []*sourceNode{}
		for _, raw := range before {
			old := asObject(raw)
			if !used[old] {
				oldGap = append(oldGap, old)
			}
		}
		for _, node := range after {
			if node.original == nil {
				newGap = append(newGap, node)
			}
		}
		if len(oldGap) == 1 && len(newGap) == 1 {
			heading, _ := oldGap[0].Get("headingLevel").(float64)
			if int(heading) == newGap[0].heading {
				newGap[0].original = oldGap[0]
				used[oldGap[0]] = true
			}
		}
		for _, node := range after {
			if node.original != nil {
				align(node.original.Array("children"), node.children)
			}
		}
	}
	align(document.Array("nodes"), roots)
	result := map[int]markdownOrigin{}
	links := scanWiki(source)
	cursor := 0
	occupied := map[string]map[int]bool{}
	for _, field := range fields {
		for cursor < len(links) && links[cursor].start < field.start {
			cursor++
		}
		within := []wikiLink{}
		for cursor < len(links) && links[cursor].end <= field.end {
			within = append(within, links[cursor])
			cursor++
		}
		if field.node.original == nil {
			continue
		}
		value := field.node.text
		if field.field == "note" {
			value = field.node.note
		}
		fieldLinks := scanWiki(value)
		fieldUsed := map[int]bool{}
		node := field.node.original
		id := node.String("id") + ":" + field.field
		if occupied[id] == nil {
			occupied[id] = map[int]bool{}
		}
		actual := scanWiki(node.String(field.field))
		for _, link := range within {
			match := -1
			for index, candidate := range fieldLinks {
				if !fieldUsed[index] && candidate.start >= field.fieldStart && candidate.raw == link.raw {
					match = index
					break
				}
			}
			if match < 0 {
				continue
			}
			fieldUsed[match] = true
			for _, candidate := range actual {
				if !occupied[id][candidate.start] && candidate.raw == link.raw {
					occupied[id][candidate.start] = true
					result[originalAt[link.start]] = markdownOrigin{node.String("id"), field.field, candidate.start, candidate.end}
					break
				}
			}
		}
	}
	return result
}
