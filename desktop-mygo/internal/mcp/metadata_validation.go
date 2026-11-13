package mcp

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

func validMetadataPayload(payload *object) bool {
	if payload.Has("title") && !isString(payload.Get("title")) || payload.Has("documentAttributes") && payload.Child("documentAttributes") == nil ||
		payload.Has("knowledge") && !knowledgeEditable(payload.Child("knowledge")) {
		return false
	}
	tree := payload.Has("structure")
	if tree && payload.String("structure") != "tree-v1" {
		return false
	}
	ids, paths, siblings := map[string]bool{}, map[string]bool{}, map[string][]int{}
	for _, raw := range payload.Array("nodes") {
		node := asObject(raw)
		if node == nil || !isString(node.Get("id")) || node.Array("path") == nil || !isString(node.Get("text")) ||
			node.Has("exportText") && !isString(node.Get("exportText")) || node.Has("note") && !isString(node.Get("note")) {
			return false
		}
		parts := []string{}
		for _, raw := range node.Array("path") {
			number, ok := raw.(float64)
			if !ok || number < 0 || math.Trunc(number) != number || math.IsInf(number, 0) {
				return false
			}
			parts = append(parts, fmt.Sprint(int(number)))
		}
		if !tree {
			continue
		}
		key := strings.Join(parts, ".")
		if node.String("id") == "" || len(parts) == 0 || ids[node.String("id")] || paths[key] || node.Has("attributes") && node.Child("attributes") == nil {
			return false
		}
		ids[node.String("id")], paths[key] = true, true
		parent := strings.Join(parts[:len(parts)-1], ".")
		siblings[parent] = append(siblings[parent], int(node.Array("path")[len(parts)-1].(float64)))
	}
	for parent, children := range siblings {
		if parent != "" && !paths[parent] {
			return false
		}
		sort.Ints(children)
		for index, child := range children {
			if child != index {
				return false
			}
		}
	}
	return true
}
