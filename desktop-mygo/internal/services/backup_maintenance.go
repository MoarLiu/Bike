package services

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// The caller holds the backup file lock. Retained JSON backups are the
// authoritative roots; objects are quarantined for 30 days before deletion.
func maintainBackupAssets(directory string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	protected := []string{}
	for _, entry := range entries {
		if entry.Name() != "bike-workspace.json" && !(strings.HasPrefix(entry.Name(), "bike-workspace-") && strings.HasSuffix(entry.Name(), ".json")) {
			continue
		}
		raw, err := readBounded(filepath.Join(directory, entry.Name()), 64*1024*1024)
		if err != nil {
			return err
		}
		_, _, assets, err := WorkspaceJSON(raw)
		if err != nil {
			return err
		}
		for _, asset := range assets {
			protected = append(protected, asset.AssetID)
		}
	}
	library := NewAttachments(filepath.Join(directory, "attachments"))
	scan, err := library.Scan(protected)
	if err != nil {
		return err
	}
	if _, err := library.Clean(protected, scan["ticket"].(string)); err != nil {
		return err
	}
	manifests := filepath.Join(directory, "attachment-manifests")
	files, err := os.ReadDir(manifests)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, file := range files {
		if file.Type().IsRegular() && regexp.MustCompile(`^[a-f0-9]{64}\.json$`).MatchString(file.Name()) {
			if err := os.Remove(filepath.Join(manifests, file.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}
