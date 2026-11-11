// Command bike-mygo-interop exercises production services from the Node verifier.
// It is a development helper and is not bundled in the application.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/services"
)

type request struct {
	Action      string             `json:"action"`
	Directory   string             `json:"directory"`
	Transfers   string             `json:"transfers"`
	Filename    string             `json:"filename"`
	Name        string             `json:"name"`
	AssetID     string             `json:"assetId"`
	Workspace   json.RawMessage    `json:"workspace"`
	Readable    *services.Readable `json:"readable"`
	Assets      []services.Asset   `json:"assets"`
	Config      map[string]any     `json:"config"`
	Request     map[string]any     `json:"request"`
	CancelPhase string             `json:"cancelPhase"`
}

func execute(input request) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	library := services.NewAttachments(input.Directory)
	switch input.Action {
	case "import":
		return library.Import(ctx, input.Filename, input.Name, true)
	case "inspect":
		file, metadata, err := library.Open(input.AssetID, nil)
		if err != nil {
			return nil, err
		}
		defer file.Close()
		hash := sha256.New()
		if _, err := io.Copy(hash, file); err != nil {
			return nil, err
		}
		return map[string]any{"assetId": "sha256:" + hex.EncodeToString(hash.Sum(nil)), "metadata": metadata}, nil
	case "exportArchive":
		return services.ExportArchive(ctx, input.Filename, input.Workspace, input.Readable, library)
	case "importArchive":
		return services.ImportArchive(ctx, input.Filename, library)
	case "network":
		return services.NewNetwork().Sync(ctx, input.Request, input.Config)
	case "sync":
		progress := []map[string]any{}
		syncer := services.AssetSync{Library: library, Directory: input.Transfers, Network: services.NewNetwork(), Progress: func(event map[string]any) {
			progress = append(progress, event)
			if input.CancelPhase != "" && event["phase"] == input.CancelPhase {
				cancel()
			}
		}}
		result, err := syncer.Run(ctx, input.Config, input.Assets)
		return map[string]any{"result": result, "progress": progress}, err
	default:
		return nil, fmt.Errorf("unknown interop action %q", input.Action)
	}
}

func main() {
	var input request
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, int64(contracts.Limits.DocumentBytes)+1))
	if err := decoder.Decode(&input); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	result, err := execute(input)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
