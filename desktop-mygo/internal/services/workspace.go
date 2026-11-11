package services

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

func validAttachmentName(name string) bool {
	return contracts.TrimJS(name) != "" && contracts.UTF16Length(name) <= 1024
}

// WorkspaceJSON preserves extension fields and the caller's JavaScript property
// order. The renderer applies the existing versioned migration before requests.
func WorkspaceJSON(raw []byte) ([]byte, map[string]any, []Asset, error) {
	if len(raw) > contracts.Limits.DocumentBytes {
		return nil, nil, nil, fmt.Errorf("工作区超过 64 MiB")
	}
	var workspace map[string]any
	if err := json.Unmarshal(raw, &workspace); err != nil {
		return nil, nil, nil, fmt.Errorf("导入文件不是有效工作区")
	}
	version, exists := workspace["version"]
	if exists && version != float64(1) && version != float64(2) && version != float64(3) {
		return nil, nil, nil, fmt.Errorf("工作区版本暂不支持，原文件已保留")
	}
	documents, ok := workspace["documents"].([]any)
	if !ok || len(documents) == 0 {
		return nil, nil, nil, fmt.Errorf("工作区至少需要一个有效文档")
	}
	if trash, exists := workspace["trash"]; exists {
		entries, ok := trash.([]any)
		if !ok {
			return nil, nil, nil, fmt.Errorf("回收站格式无效")
		}
		for _, entry := range entries {
			value, ok := entry.(map[string]any)
			if !ok {
				return nil, nil, nil, fmt.Errorf("回收站格式无效")
			}
			documents = append(documents, value["document"])
		}
	}
	assets := []Asset{}
	seen := map[string]Metadata{}
	for _, entry := range documents {
		document, ok := entry.(map[string]any)
		if !ok {
			return nil, nil, nil, fmt.Errorf("文档格式无效")
		}
		nodes, ok := document["nodes"].([]any)
		if !ok {
			return nil, nil, nil, fmt.Errorf("文档缺少有效主题数组")
		}
		manifest := map[string]Metadata{}
		if value, exists := document["attachments"]; exists {
			wrapper, ok := value.(map[string]any)
			if !ok || wrapper["version"] != float64(1) {
				return nil, nil, nil, fmt.Errorf("附件格式版本暂不支持")
			}
			items, ok := wrapper["items"].(map[string]any)
			if !ok {
				return nil, nil, nil, fmt.Errorf("附件清单无效")
			}
			for id, value := range items {
				if _, err := assetDigest(id); err != nil {
					return nil, nil, nil, err
				}
				encoded, _ := json.Marshal(value)
				var metadata Metadata
				if err := json.Unmarshal(encoded, &metadata); err != nil {
					return nil, nil, nil, fmt.Errorf("附件元数据无效")
				}
				if err := ValidateMetadata(metadata); err != nil {
					return nil, nil, nil, err
				}
				manifest[id] = metadata
			}
		}
		type frame struct {
			nodes []any
			depth int
		}
		stack := []frame{{nodes, 1}}
		count := 0
		for len(stack) > 0 {
			current := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			count += len(current.nodes)
			if count > contracts.Limits.DocumentNodes || current.depth > contracts.Limits.DesktopDepth {
				return nil, nil, nil, fmt.Errorf("主题数量或深度超过处理预算")
			}
			for _, rawNode := range current.nodes {
				node, ok := rawNode.(map[string]any)
				if !ok {
					return nil, nil, nil, fmt.Errorf("附件主题结构无效")
				}
				if refs, exists := node["attachmentRefs"]; exists {
					list, ok := refs.([]any)
					if !ok {
						return nil, nil, nil, fmt.Errorf("主题附件引用无效")
					}
					for _, item := range list {
						ref, ok := item.(map[string]any)
						if !ok {
							return nil, nil, nil, fmt.Errorf("主题附件引用无效")
						}
						id, name := text(ref, "assetId"), text(ref, "name")
						if _, err := assetDigest(id); err != nil {
							return nil, nil, nil, err
						}
						if !validAttachmentName(name) {
							return nil, nil, nil, fmt.Errorf("附件显示名无效")
						}
						if value, exists := ref["alt"]; exists {
							alt, ok := value.(string)
							if !ok || contracts.UTF16Length(alt) > 10000 {
								return nil, nil, nil, fmt.Errorf("附件替代文字无效")
							}
						}
						metadata, ok := manifest[id]
						if !ok {
							return nil, nil, nil, fmt.Errorf("附件缺少元数据")
						}
						if prior, exists := seen[id]; exists && prior != metadata {
							return nil, nil, nil, fmt.Errorf("相同附件摘要对应的元数据不一致")
						}
						if _, exists := seen[id]; !exists {
							assets = append(assets, Asset{AssetID: id, Metadata: metadata})
							seen[id] = metadata
						}
					}
				}
				if children, exists := node["children"]; exists {
					list, ok := children.([]any)
					if !ok {
						return nil, nil, nil, fmt.Errorf("主题子项格式无效")
					}
					if len(list) > 0 {
						stack = append(stack, frame{list, current.depth + 1})
					}
				}
			}
		}
	}
	if _, exists := workspace["localMigration"]; exists {
		ordered, complete, err := validateLocalMigration(raw, assets)
		if err != nil {
			return nil, nil, nil, err
		}
		assets = complete
		for _, key := range ordered.Keys {
			workspace[key] = ordered.Get(key)
		}
	}
	var formatted bytes.Buffer
	if err := json.Indent(&formatted, raw, "", "  "); err != nil {
		return nil, nil, nil, err
	}
	formatted.WriteByte('\n')
	if formatted.Len() > contracts.Limits.DocumentBytes {
		return nil, nil, nil, fmt.Errorf("工作区超过 64 MiB")
	}
	return formatted.Bytes(), workspace, assets, nil
}
