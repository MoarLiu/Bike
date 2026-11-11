package contracts

import (
	_ "embed"
	"encoding/json"
)

// Generated from the browser/Node shared modules by scripts/mygo-contracts.mjs.
//
//go:embed limits.json
var limitsJSON []byte

type ResourceLimits struct {
	DocumentBytes     int `json:"documentBytes"`
	DocumentNodes     int `json:"documentNodes"`
	DesktopDepth      int `json:"desktopDepth"`
	OperationBytes    int `json:"operationBytes"`
	AttachmentBytes   int `json:"attachmentBytes"`
	ImageBytes        int `json:"imageBytes"`
	ImagePixels       int `json:"imagePixels"`
	ImportFiles       int `json:"importFiles"`
	ImportBytes       int `json:"importBytes"`
	JSONDepth         int `json:"jsonDepth"`
	AITimeoutMS       int `json:"aiTimeoutMs"`
	SyncTimeoutMS     int `json:"syncTimeoutMs"`
	AIResponseBytes   int `json:"aiResponseBytes"`
	SyncResponseBytes int `json:"syncResponseBytes"`
	OperationLimits   struct {
		CheckpointBytes      int `json:"checkpointBytes"`
		AttachmentChunkBytes int `json:"attachmentChunkBytes"`
	} `json:"operationLimits"`
}

var Limits = func() ResourceLimits {
	var limits ResourceLimits
	if err := json.Unmarshal(limitsJSON, &limits); err != nil {
		panic(err)
	}
	return limits
}()
