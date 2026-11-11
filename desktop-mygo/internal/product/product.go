package product

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"path/filepath"
)

//go:embed product.json
var configuration []byte

// Build, Commit and Channel are set by the build script. Source builds use the
// preview identity so they cannot acquire a released client's profile or lock.
var Build = "0"
var Commit = "unbuilt"
var Channel = "preview"

type Info struct {
	Version                    string `json:"version"`
	Form                       string `json:"form"`
	Name                       string `json:"name"`
	Executable                 string `json:"executable"`
	Identifier                 string `json:"identifier"`
	Profile                    string `json:"profile"`
	BackupDirectory            string `json:"backupDirectory"`
	TagPrefix                  string `json:"tagPrefix"`
	MinimumSystemVersion       string `json:"minimumSystemVersion"`
	TargetMinimumSystemVersion string `json:"targetMinimumSystemVersion"`
	Go                         string `json:"go"`
	GoExperiment               string `json:"goExperiment"`
	MyGOCompatibilityPatch     string `json:"mygoCompatibilityPatch"`
	MyGO                       string `json:"mygo"`
	MyGOCommit                 string `json:"mygoCommit"`
	McpSDK                     string `json:"mcpSdk"`
	Build                      string `json:"build"`
	Commit                     string `json:"commit"`
	Channel                    string `json:"channel"`
}

func Current() (Info, error) {
	var info Info
	if err := json.Unmarshal(configuration, &info); err != nil {
		return info, err
	}
	if Channel != "stable" && Channel != "preview" {
		return info, fmt.Errorf("unknown MyGO channel %q", Channel)
	}
	info.Build, info.Commit, info.Channel = Build, Commit, Channel
	if Channel == "preview" {
		info.Name += " Preview"
		info.Identifier += ".preview"
		info.Profile += "-preview"
		info.BackupDirectory += "-preview"
	}
	return info, nil
}

func (info Info) ProfilePath(home string) string {
	return filepath.Join(home, "Library", "Application Support", info.Profile)
}

func (info Info) DiscoveryPath(home string) string {
	return filepath.Join(info.ProfilePath(home), "live-mcp.json")
}
