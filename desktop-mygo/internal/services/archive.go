package services

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

const archiveMaximum int64 = 512 * 1024 * 1024
const extractedMaximum int64 = 1024 * 1024 * 1024
const archiveEntries = 10000

type Readable struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}
type archiveManifest struct {
	Format           string  `json:"format"`
	Version          int     `json:"version"`
	Complete         bool    `json:"complete"`
	WorkspaceVersion int     `json:"workspaceVersion"`
	WorkspaceSHA256  string  `json:"workspaceSha256"`
	Assets           []Asset `json:"assets"`
	Readable         *struct {
		Name   string `json:"name"`
		SHA256 string `json:"sha256"`
	} `json:"readable,omitempty"`
}

func digestBytes(value []byte) string { sum := sha256.Sum256(value); return hex.EncodeToString(sum[:]) }

type budgetWriter struct {
	writer  io.Writer
	written int64
	maximum int64
}

func (writer *budgetWriter) Write(value []byte) (int, error) {
	if writer.written+int64(len(value)) > writer.maximum {
		return 0, fmt.Errorf("归档超过输出预算")
	}
	count, err := writer.writer.Write(value)
	writer.written += int64(count)
	return count, err
}

func ExportArchive(ctx context.Context, filename string, raw []byte, readable *Readable, library *Attachments) (map[string]any, error) {
	content, workspace, assets, err := WorkspaceJSON(raw)
	if err != nil {
		return nil, err
	}
	version := 1
	if number, ok := workspace["version"].(float64); ok {
		version = int(number)
	}
	manifest := archiveManifest{Format: "bike-workspace", Version: 1, Complete: true, WorkspaceVersion: version, WorkspaceSHA256: digestBytes(content), Assets: assets}
	total := int64(len(content))
	if readable != nil {
		if (readable.Name != "document.md" && readable.Name != "index.html") || len(readable.Content) > contracts.Limits.DocumentBytes {
			return nil, fmt.Errorf("导出正文参数无效或超过预算")
		}
		manifest.Readable = &struct {
			Name   string `json:"name"`
			SHA256 string `json:"sha256"`
		}{readable.Name, digestBytes([]byte(readable.Content))}
		total += int64(len(readable.Content))
	}
	for _, asset := range assets {
		total += asset.Metadata.ByteLength
	}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, err
	}
	if len(encoded) > contracts.Limits.OperationBytes || len(assets)+3 > archiveEntries || total+int64(len(encoded)+(len(assets)+3)*512) > archiveMaximum {
		return nil, fmt.Errorf("工作区超过归档处理预算")
	}
	err = AtomicFile(ctx, filename, func(output io.Writer) error {
		meter := &budgetWriter{writer: output, maximum: archiveMaximum}
		archive := zip.NewWriter(meter)
		add := func(name string, source io.Reader, method uint16) error {
			header := &zip.FileHeader{Name: name, Method: method}
			header.SetMode(0600)
			writer, err := archive.CreateHeader(header)
			if err != nil {
				return err
			}
			_, err = io.Copy(writer, contextReader{ctx, source})
			return err
		}
		if err := add("manifest.json", strings.NewReader(string(encoded)), zip.Deflate); err != nil {
			return err
		}
		if err := add("workspace.json", strings.NewReader(string(content)), zip.Deflate); err != nil {
			return err
		}
		if readable != nil {
			if err := add(readable.Name, strings.NewReader(readable.Content), zip.Deflate); err != nil {
				return err
			}
		}
		for _, asset := range assets {
			file, _, err := library.Open(asset.AssetID, &asset.Metadata)
			if err != nil {
				return err
			}
			hash := sha256.New()
			err = add("attachments/"+asset.AssetID[7:], io.TeeReader(file, hash), zip.Store)
			file.Close()
			if err != nil {
				return err
			}
			if hex.EncodeToString(hash.Sum(nil)) != asset.AssetID[7:] {
				return fmt.Errorf("附件在导出期间发生变化")
			}
		}
		return archive.Close()
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": filename, "attachmentCount": len(assets)}, nil
}

func ImportArchive(ctx context.Context, filename string, library *Attachments) (map[string]any, error) {
	source, err := openRegular(filename)
	if err != nil {
		return nil, err
	}
	defer source.Close()
	stat, err := source.Stat()
	if err != nil {
		return nil, err
	}
	if stat.Size() > archiveMaximum {
		return nil, fmt.Errorf("归档无效或超过 512 MiB")
	}
	if err := preflightArchive(source, stat.Size()); err != nil {
		return nil, err
	}
	archive, err := zip.NewReader(source, stat.Size())
	if err != nil {
		return nil, err
	}
	if len(archive.File) > archiveEntries {
		return nil, fmt.Errorf("归档条目超过 10,000 项")
	}
	staging, err := os.MkdirTemp("", "bike-mygo-archive-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(staging)
	type extracted struct {
		path string
		size int64
		hash string
	}
	entries := map[string]extracted{}
	var total int64
	for _, entry := range archive.File {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		name := entry.Name
		valid := name == "manifest.json" || name == "workspace.json" || name == "document.md" || name == "index.html"
		if strings.HasPrefix(name, "attachments/") {
			_, err := assetDigest("sha256:" + strings.TrimPrefix(name, "attachments/"))
			valid = err == nil
		}
		if !valid || !entry.Mode().IsRegular() || entry.Flags&1 != 0 {
			return nil, fmt.Errorf("归档包含不支持的路径、加密条目或特殊文件")
		}
		if _, exists := entries[name]; exists {
			return nil, fmt.Errorf("归档包含重复路径")
		}
		maximum := int64(contracts.Limits.DocumentBytes)
		if name == "manifest.json" {
			maximum = int64(contracts.Limits.OperationBytes)
		}
		if strings.HasPrefix(name, "attachments/") {
			maximum = int64(contracts.Limits.AttachmentBytes)
		}
		if entry.UncompressedSize64 > uint64(maximum) || total+int64(entry.UncompressedSize64) > extractedMaximum {
			return nil, fmt.Errorf("归档解压内容超过处理预算")
		}
		input, err := entry.Open()
		if err != nil {
			return nil, err
		}
		output, err := os.OpenFile(filepath.Join(staging, identifier()), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			input.Close()
			return nil, err
		}
		hash := sha256.New()
		count, err := io.Copy(io.MultiWriter(output, hash), io.LimitReader(contextReader{ctx, input}, maximum+1))
		input.Close()
		closeError := output.Close()
		total += count
		if err != nil {
			return nil, err
		}
		if closeError != nil {
			return nil, closeError
		}
		if count > maximum || total > extractedMaximum || uint64(count) != entry.UncompressedSize64 {
			return nil, fmt.Errorf("归档解压内容超过处理预算或长度不一致")
		}
		entries[name] = extracted{output.Name(), count, hex.EncodeToString(hash.Sum(nil))}
	}
	manifestEntry, ok := entries["manifest.json"]
	if !ok {
		return nil, fmt.Errorf("归档缺少清单")
	}
	workspaceEntry, ok := entries["workspace.json"]
	if !ok {
		return nil, fmt.Errorf("归档缺少工作区")
	}
	manifestBytes, err := readBounded(manifestEntry.path, int64(contracts.Limits.OperationBytes))
	if err != nil {
		return nil, err
	}
	var manifest archiveManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(manifestBytes, &fields); err != nil || len(fields["assets"]) == 0 || fields["assets"][0] != '[' {
		return nil, fmt.Errorf("归档附件清单无效")
	}
	if manifest.Format != "bike-workspace" || manifest.Version != 1 || !manifest.Complete || manifest.WorkspaceSHA256 != workspaceEntry.hash {
		return nil, fmt.Errorf("归档版本或完整性校验失败")
	}
	raw, err := readBounded(workspaceEntry.path, int64(contracts.Limits.DocumentBytes))
	if err != nil {
		return nil, err
	}
	_, workspace, assets, err := WorkspaceJSON(raw)
	if err != nil {
		return nil, err
	}
	version := 1
	if number, ok := workspace["version"].(float64); ok {
		version = int(number)
	}
	if manifest.WorkspaceVersion != version || len(manifest.Assets) != len(assets) {
		return nil, fmt.Errorf("归档附件清单不闭合或版本不一致")
	}
	expectedEntries := len(assets) + 2
	if manifest.Readable != nil {
		expectedEntries++
		entry, exists := entries[manifest.Readable.Name]
		if !exists || (manifest.Readable.Name != "document.md" && manifest.Readable.Name != "index.html") || entry.hash != manifest.Readable.SHA256 {
			return nil, fmt.Errorf("归档可读正文校验失败")
		}
	}
	if len(entries) != expectedEntries {
		return nil, fmt.Errorf("归档清单不闭合")
	}
	listed := map[string]Metadata{}
	for _, item := range manifest.Assets {
		if _, exists := listed[item.AssetID]; exists {
			return nil, fmt.Errorf("归档附件清单重复")
		}
		listed[item.AssetID] = item.Metadata
	}
	for _, asset := range assets {
		entry, exists := entries["attachments/"+asset.AssetID[7:]]
		if !exists || entry.hash != asset.AssetID[7:] || entry.size != asset.Metadata.ByteLength || listed[asset.AssetID] != asset.Metadata {
			return nil, fmt.Errorf("归档附件缺失或摘要不一致")
		}
		file, err := openRegular(entry.path)
		if err != nil {
			return nil, err
		}
		id, metadata, err := inspectFile(file)
		file.Close()
		if err != nil || id != asset.AssetID || metadata != asset.Metadata {
			return nil, fmt.Errorf("归档附件媒体类型或尺寸不一致")
		}
	}
	// Every required entry has been checked before any live object is installed.
	for _, asset := range assets {
		if _, err := library.Import(ctx, entries["attachments/"+asset.AssetID[7:]].path, "附件", true); err != nil {
			return nil, err
		}
	}
	return map[string]any{"workspace": json.RawMessage(raw), "attachmentCount": len(assets)}, nil
}
