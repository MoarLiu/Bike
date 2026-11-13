//go:build darwin

package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/services"
	"path/filepath"
)

func (desktop *Desktop) syncAssets(ctx context.Context, request map[string]any) (map[string]any, error) {
	config, err := desktop.configuration(ctx, "sync")
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(request["assets"])
	if err != nil {
		return nil, err
	}
	var assets []services.Asset
	if err := json.Unmarshal(raw, &assets); err != nil {
		return nil, err
	}
	batches, total, err := services.AssetBatches(assets)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	desktop.mu.Lock()
	if desktop.assetSync != nil {
		desktop.mu.Unlock()
		return nil, fmt.Errorf("附件同步仍在进行")
	}
	desktop.assetSync = cancel
	desktop.mu.Unlock()
	defer func() { desktop.mu.Lock(); desktop.assetSync = nil; desktop.mu.Unlock() }()
	syncer := services.AssetSync{Library: desktop.Library, Directory: filepath.Join(desktop.Profile, "attachment-transfers"), Network: desktop.Network, Progress: func(progress map[string]any) { desktop.Emit("attachmentSyncProgress", progress) }}
	result := map[string]any{"ok": true, "complete": true, "completed": 0, "total": total, "errors": []map[string]any{}}
	for _, assets := range batches {
		batch, err := syncer.Run(ctx, config, assets)
		if err != nil {
			return nil, err
		}
		if count, ok := batch["completed"].(int); ok {
			result["completed"] = result["completed"].(int) + count
		}
		if errors, ok := batch["errors"].([]map[string]any); ok {
			result["errors"] = append(result["errors"].([]map[string]any), errors...)
		}
		if batch["complete"] != true {
			result["complete"] = false
			break
		}
	}
	return result, nil
}
func (desktop *Desktop) cancelAssetSync() {
	desktop.mu.Lock()
	defer desktop.mu.Unlock()
	if desktop.assetSync != nil {
		desktop.assetSync()
	}
}
