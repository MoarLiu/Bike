package services

import (
	"fmt"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

func AssetBatches(assets []Asset) ([][]Asset, int, error) {
	batches := [][]Asset{}
	current := []Asset{}
	seen := map[string]Metadata{}
	var size int64
	total := 0
	for _, asset := range assets {
		if _, err := assetDigest(asset.AssetID); err != nil {
			return nil, 0, err
		}
		if err := ValidateMetadata(asset.Metadata); err != nil {
			return nil, 0, err
		}
		if previous, exists := seen[asset.AssetID]; exists {
			if previous != asset.Metadata {
				return nil, 0, fmt.Errorf("附件清单元数据冲突")
			}
			continue
		}
		seen[asset.AssetID] = asset.Metadata
		if len(current) == 1000 || len(current) > 0 && size+asset.Metadata.ByteLength > int64(contracts.Limits.ImportBytes) {
			batches = append(batches, current)
			current, size = nil, 0
		}
		current = append(current, asset)
		size += asset.Metadata.ByteLength
		total++
	}
	if len(current) > 0 {
		batches = append(batches, current)
	}
	return batches, total, nil
}
