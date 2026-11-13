package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

type AssetSync struct {
	Library    *Attachments
	Directory  string
	Network    *Network
	Progress   func(map[string]any)
	runMu      sync.Mutex
	progressMu sync.Mutex
}
type transferError struct {
	message string
	status  int
	code    string
}

func (err transferError) Error() string { return err.message }
func (syncer *AssetSync) report(asset Asset, phase string, transferred int64) {
	syncer.progressMu.Lock()
	defer syncer.progressMu.Unlock()
	if syncer.Progress != nil {
		syncer.Progress(map[string]any{"assetId": asset.AssetID, "phase": phase, "transferred": transferred, "byteLength": asset.Metadata.ByteLength})
	}
}
func (syncer *AssetSync) request(ctx context.Context, config map[string]any, suffix, method string, body any, binaryBody bool) ([]byte, http.Header, error) {
	base, err := endpoint(text(config, "serverUrl"))
	if err != nil {
		return nil, nil, err
	}
	if base.RawQuery != "" || base.ForceQuery || strings.Contains(text(config, "serverUrl"), "#") {
		return nil, nil, fmt.Errorf("同步服务地址无效")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(contracts.Limits.SyncTimeoutMS)*time.Millisecond)
	defer cancel()
	var input io.Reader
	if binaryBody {
		value, ok := body.([]byte)
		if !ok {
			return nil, nil, fmt.Errorf("附件分块参数无效")
		}
		input = bytes.NewReader(value)
	} else if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, nil, err
		}
		input = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(base.String(), "/")+"/api/v2/assets/"+suffix, input)
	if err != nil {
		return nil, nil, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(text(config, "token")))
	if body != nil {
		contentType := "application/json"
		if binaryBody {
			contentType = "application/octet-stream"
		}
		request.Header.Set("Content-Type", contentType)
	}
	response, err := syncer.Network.Client.Do(request)
	if err != nil {
		return nil, nil, fmt.Errorf("附件网络请求失败或已取消")
	}
	defer response.Body.Close()
	maximum := 64 * 1024
	if method == http.MethodGet {
		maximum = contracts.Limits.OperationLimits.AttachmentChunkBytes
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, int64(maximum)+1))
	if err != nil {
		return nil, nil, err
	}
	if len(raw) > maximum {
		return nil, nil, fmt.Errorf("附件响应超过分块预算")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var data map[string]any
		json.Unmarshal(raw, &data)
		return nil, nil, transferError{providerError(data, response.StatusCode), response.StatusCode, text(data, "error")}
	}
	return raw, response.Header, nil
}
func (syncer *AssetSync) upload(ctx context.Context, config map[string]any, asset Asset, file *os.File) (err error) {
	raw, _, err := syncer.request(ctx, config, asset.AssetID[7:]+"/lease", http.MethodPost, asset.Metadata, false)
	if err != nil {
		return err
	}
	var lease struct {
		Complete   *bool  `json:"complete"`
		Offset     *int64 `json:"offset"`
		ByteLength *int64 `json:"byteLength"`
		UploadID   string `json:"uploadId"`
	}
	if err := json.Unmarshal(raw, &lease); err != nil {
		return err
	}
	if lease.Complete == nil || lease.Offset == nil || *lease.Offset < 0 || *lease.Offset > asset.Metadata.ByteLength || lease.ByteLength != nil && *lease.ByteLength != asset.Metadata.ByteLength {
		return fmt.Errorf("远端上传租约无效")
	}
	if *lease.Complete {
		if *lease.Offset != asset.Metadata.ByteLength {
			return fmt.Errorf("远端上传租约无效")
		}
		syncer.report(asset, "complete", asset.Metadata.ByteLength)
		return nil
	}
	if lease.UploadID == "" {
		return fmt.Errorf("远端上传租约无效")
	}
	defer func() {
		var failure transferError
		if errors.As(err, &failure) && (failure.code == "asset_integrity" || failure.code == "asset_metadata") {
			// Only integrity failures discard a lease. Cancellation and disk errors
			// retain the server's persisted offset for the next run.
			syncer.request(ctx, config, asset.AssetID[7:]+"/lease", http.MethodDelete, map[string]any{"uploadId": lease.UploadID}, false)
		}
	}()
	buffer := make([]byte, contracts.Limits.OperationLimits.AttachmentChunkBytes)
	for offset := *lease.Offset; offset < asset.Metadata.ByteLength; {
		if err := ctx.Err(); err != nil {
			return err
		}
		wanted := min(int64(len(buffer)), asset.Metadata.ByteLength-offset)
		count, err := file.ReadAt(buffer[:wanted], offset)
		if err != nil || int64(count) != wanted {
			return fmt.Errorf("本机附件在上传期间发生变化")
		}
		suffix := asset.AssetID[7:] + "/chunks?uploadId=" + url.QueryEscape(lease.UploadID) + "&offset=" + strconv.FormatInt(offset, 10)
		raw, _, err := syncer.request(ctx, config, suffix, http.MethodPut, buffer[:count], true)
		if err != nil {
			return err
		}
		var next struct {
			Offset int64 `json:"offset"`
		}
		if err := json.Unmarshal(raw, &next); err != nil {
			return err
		}
		if next.Offset < offset+wanted || next.Offset > asset.Metadata.ByteLength {
			return fmt.Errorf("远端续传偏移无效")
		}
		offset = next.Offset
		syncer.report(asset, "upload", offset)
	}
	raw, _, err = syncer.request(ctx, config, asset.AssetID[7:]+"/finish", http.MethodPost, map[string]any{"uploadId": lease.UploadID}, false)
	if err != nil {
		return err
	}
	var finished struct {
		Complete   bool   `json:"complete"`
		AssetID    string `json:"assetId"`
		ByteLength int64  `json:"byteLength"`
	}
	if err := json.Unmarshal(raw, &finished); err != nil || !finished.Complete || finished.AssetID != asset.AssetID || finished.ByteLength != asset.Metadata.ByteLength {
		return fmt.Errorf("远端附件安装回执无效")
	}
	syncer.report(asset, "complete", asset.Metadata.ByteLength)
	return nil
}
func (syncer *AssetSync) download(ctx context.Context, config map[string]any, asset Asset) error {
	if err := privateDirectory(syncer.Directory); err != nil {
		return err
	}
	digest := asset.AssetID[7:]
	partial := filepath.Join(syncer.Directory, digest+".part")
	receipt := filepath.Join(syncer.Directory, digest+".json")
	encoded, _ := json.Marshal(asset)
	if err := writeBytes(receipt, encoded); err != nil {
		return err
	}
	file, err := os.OpenFile(partial, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("附件暂存文件无效")
	}
	offset := info.Size()
	if offset > asset.Metadata.ByteLength {
		if err := file.Truncate(0); err != nil {
			return err
		}
		offset = 0
	}
	for offset < asset.Metadata.ByteLength || asset.Metadata.ByteLength == 0 {
		if err := ctx.Err(); err != nil {
			return err
		}
		suffix := digest + "?offset=" + strconv.FormatInt(offset, 10) + "&length=" + strconv.Itoa(contracts.Limits.OperationLimits.AttachmentChunkBytes)
		raw, headers, err := syncer.request(ctx, config, suffix, http.MethodGet, nil, false)
		if err != nil {
			return err
		}
		length, err := strconv.ParseInt(headers.Get("x-bike-asset-length"), 10, 64)
		if err != nil || length != asset.Metadata.ByteLength || offset+int64(len(raw)) > length || len(raw) == 0 && length > 0 {
			return fmt.Errorf("下载长度与附件清单不一致")
		}
		count, err := file.WriteAt(raw, offset)
		if err != nil {
			return err
		}
		if count != len(raw) {
			return io.ErrShortWrite
		}
		offset += int64(count)
		if err := file.Sync(); err != nil {
			return err
		}
		syncer.report(asset, "download", offset)
		if length == 0 {
			break
		}
	}
	if err := file.Sync(); err != nil {
		return err
	}
	id, metadata, err := inspectFile(file)
	if err != nil || id != asset.AssetID || metadata != asset.Metadata {
		file.Close()
		os.Remove(partial)
		os.Remove(receipt)
		return fmt.Errorf("下载附件完整性校验失败")
	}
	file.Close()
	if err := ctx.Err(); err != nil {
		return err
	}
	installed, err := syncer.Library.Import(ctx, partial, "附件", true)
	if err != nil {
		return err
	}
	if installed.AssetID != asset.AssetID || installed.Metadata != asset.Metadata {
		return fmt.Errorf("下载附件安装摘要不一致")
	}
	os.Remove(partial)
	os.Remove(receipt)
	syncer.report(asset, "complete", asset.Metadata.ByteLength)
	return nil
}
func (syncer *AssetSync) Run(ctx context.Context, config map[string]any, assets []Asset) (map[string]any, error) {
	if !syncer.runMu.TryLock() {
		return nil, fmt.Errorf("附件同步仍在进行")
	}
	defer syncer.runMu.Unlock()
	if err := CleanupTransferFiles(syncer.Directory); err != nil {
		return nil, err
	}
	if strings.TrimSpace(text(config, "token")) == "" {
		return nil, fmt.Errorf("请先保存同步服务地址和设备密钥")
	}
	base, err := endpoint(text(config, "serverUrl"))
	if err != nil || base.RawQuery != "" || base.ForceQuery || strings.Contains(text(config, "serverUrl"), "#") {
		return nil, fmt.Errorf("同步服务地址无效")
	}
	if len(assets) > 1000 {
		return nil, fmt.Errorf("附件同步单批最多 1,000 个对象")
	}
	seen := map[string]Metadata{}
	items := []Asset{}
	var total int64
	for _, asset := range assets {
		if _, err := assetDigest(asset.AssetID); err != nil {
			return nil, err
		}
		if err := ValidateMetadata(asset.Metadata); err != nil {
			return nil, err
		}
		if prior, exists := seen[asset.AssetID]; exists {
			if prior != asset.Metadata {
				return nil, fmt.Errorf("附件清单元数据冲突")
			}
			continue
		}
		seen[asset.AssetID] = asset.Metadata
		items = append(items, asset)
		total += asset.Metadata.ByteLength
	}
	if total > int64(contracts.Limits.ImportBytes) {
		return nil, fmt.Errorf("附件同步单批超过 512 MiB，请分批同步")
	}
	if len(items) > 0 {
		if syncer.Library == nil || syncer.Network == nil || syncer.Network.Client == nil {
			return nil, fmt.Errorf("附件同步服务尚未就绪")
		}
		if err := privateDirectory(syncer.Directory); err != nil {
			return nil, err
		}
		lock, err := os.OpenFile(filepath.Join(syncer.Directory, ".sync.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0600)
		if err != nil {
			return nil, err
		}
		defer lock.Close()
		info, err := lock.Stat()
		if err != nil || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("附件同步锁无效")
		}
		if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			return nil, fmt.Errorf("附件同步仍在进行")
		}
		defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	}
	completed := 0
	failures := []map[string]any{}
	type outcome struct {
		asset Asset
		err   error
	}
	jobs := make(chan Asset, len(items))
	results := make(chan outcome, len(items))
	for _, asset := range items {
		jobs <- asset
	}
	close(jobs)
	var workers sync.WaitGroup
	// Matches OPERATION_LIMITS.attachmentConcurrent in the shared protocol.
	for worker := 0; worker < min(2, len(items)); worker++ {
		workers.Go(func() {
			for asset := range jobs {
				if ctx.Err() != nil {
					return
				}
				file, _, err := syncer.Library.Open(asset.AssetID, &asset.Metadata)
				if err == nil {
					err = syncer.upload(ctx, config, asset, file)
					file.Close()
				} else if os.IsNotExist(err) || errors.Is(err, ErrAttachmentIntegrity) {
					err = syncer.download(ctx, config, asset)
				}
				if err != nil {
					syncer.report(asset, "error", 0)
				}
				results <- outcome{asset, err}
			}
		})
	}
	workers.Wait()
	close(results)
	for result := range results {
		if result.err != nil {
			message := result.err.Error()
			if errors.Is(result.err, syscall.ENOSPC) {
				message = "本机磁盘空间不足，传输状态和原件已保留"
			}
			failures = append(failures, map[string]any{"assetId": result.asset.AssetID, "message": message})
		} else {
			completed++
		}
	}
	return map[string]any{"complete": completed == len(items), "completed": completed, "total": len(items), "errors": failures}, nil
}
