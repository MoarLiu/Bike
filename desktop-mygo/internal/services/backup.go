package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

type BackupRequest struct {
	Workspace        json.RawMessage `json:"workspace"`
	SourceRevision   int64           `json:"sourceRevision"`
	SemanticHash     string          `json:"semanticHash"`
	Ticket           int64           `json:"ticket"`
	Manual           bool            `json:"manual"`
	ResumeSource     bool            `json:"resumeSource"`
	ExpectedFileHash *string         `json:"expectedFileHash"`
}
type backupSettings struct {
	Version            int     `json:"version"`
	Auto               bool    `json:"auto"`
	BaselineHash       *string `json:"baselineHash"`
	LastContentHash    *string `json:"lastContentHash"`
	LastSemanticHash   *string `json:"lastSemanticHash"`
	LastSuccessAt      *string `json:"lastSuccessAt"`
	LastTicket         int64   `json:"lastTicket"`
	LastSourceRevision int64   `json:"lastSourceRevision"`
	LastSourceHash     *string `json:"lastSourceHash"`
	LastStampAt        int64   `json:"lastStampAt"`
	Paused             *string `json:"paused"`
	RetryCount         int     `json:"retryCount"`
	LastError          any     `json:"lastError"`
}
type Backups struct {
	Profile    string
	Directory  string
	Library    *Attachments
	Verify     func(context.Context, BackupRequest) error
	mu         sync.Mutex
	settings   backupSettings
	loaded     bool
	pending    *BackupRequest
	lastResult map[string]any
	retry      *time.Timer
	closed     bool
}

var errBackupBaselineChanged = errors.New("iCloud 文件有外部修改，已暂停自动备份")

func pointer(value string) *string { return &value }
func NewBackups(profile, directory string, library *Attachments, verify func(context.Context, BackupRequest) error) *Backups {
	return &Backups{Profile: profile, Directory: directory, Library: library, Verify: verify, settings: backupSettings{Version: 1}}
}
func (backup *Backups) loadLocked() error {
	if backup.loaded {
		return nil
	}
	if err := privateDirectory(backup.Profile); err != nil {
		return err
	}
	backup.loaded = true
	raw, err := readBounded(filepath.Join(backup.Profile, "backup-settings.json"), 1024*1024)
	if err == nil {
		if err := json.Unmarshal(raw, &backup.settings); err != nil {
			backup.settings.Auto = false
			backup.settings.Paused = pointer("settings-error")
			backup.settings.LastError = map[string]any{"code": "write-failed", "message": "备份设置无效，已暂停并保留原文件"}
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	raw, err = readBounded(filepath.Join(backup.Profile, "backup-pending.json"), int64(contracts.Limits.DocumentBytes)+4096)
	if err == nil {
		var request BackupRequest
		if err := json.Unmarshal(raw, &request); err != nil {
			return err
		}
		backup.pending = &request
	} else if !os.IsNotExist(err) {
		return err
	}
	return nil
}
func (backup *Backups) persistLocked() error {
	value, err := json.MarshalIndent(backup.settings, "", "  ")
	if err != nil {
		return err
	}
	return writeBytes(filepath.Join(backup.Profile, "backup-settings.json"), value)
}
func (backup *Backups) statusLocked() map[string]any {
	return map[string]any{"auto": backup.settings.Auto, "paused": backup.settings.Paused, "baselineHash": backup.settings.BaselineHash, "lastSuccessAt": backup.settings.LastSuccessAt, "lastSemanticHash": backup.settings.LastSemanticHash, "lastError": backup.settings.LastError, "lastTicket": backup.settings.LastTicket, "writing": false, "pending": backup.pending != nil, "unfinishedReceipt": backup.pending, "lastResult": backup.lastResult}
}
func (backup *Backups) Status() (map[string]any, error) {
	backup.mu.Lock()
	defer backup.mu.Unlock()
	if err := backup.loadLocked(); err != nil {
		return nil, err
	}
	return backup.statusLocked(), nil
}
func (backup *Backups) SetAuto(enabled bool) (map[string]any, error) {
	backup.mu.Lock()
	defer backup.mu.Unlock()
	if err := backup.loadLocked(); err != nil {
		return nil, err
	}
	backup.settings.Auto = enabled
	if !enabled {
		if backup.retry != nil {
			backup.retry.Stop()
		}
		backup.settings.Paused = nil
		backup.settings.RetryCount = 0
	}
	if err := backup.persistLocked(); err != nil {
		return nil, err
	}
	return backup.statusLocked(), nil
}
func (backup *Backups) Pause(reason string) (map[string]any, error) {
	backup.mu.Lock()
	defer backup.mu.Unlock()
	if err := backup.loadLocked(); err != nil {
		return nil, err
	}
	if backup.settings.Paused == nil || *backup.settings.Paused != "external-change" {
		backup.settings.Paused = pointer(reason)
	}
	if backup.retry != nil {
		backup.retry.Stop()
	}
	if err := backup.persistLocked(); err != nil {
		return nil, err
	}
	return backup.statusLocked(), nil
}
func (backup *Backups) Close() {
	backup.mu.Lock()
	defer backup.mu.Unlock()
	backup.closed = true
	if backup.retry != nil {
		backup.retry.Stop()
	}
}
func (backup *Backups) Current() (raw []byte, hash *string, err error) {
	raw, err = readBounded(filepath.Join(backup.Directory, "bike-workspace.json"), int64(contracts.Limits.DocumentBytes))
	if os.IsNotExist(err) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	return raw, pointer(digestBytes(raw)), nil
}
func (backup *Backups) Inspect() (map[string]any, error) {
	backup.mu.Lock()
	defer backup.mu.Unlock()
	if err := backup.loadLocked(); err != nil {
		return nil, err
	}
	_, hash, err := backup.Current()
	if err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "exists": hash != nil, "path": filepath.Join(backup.Directory, "bike-workspace.json"), "fileHash": hash, "baselineHash": backup.settings.BaselineHash, "paused": backup.settings.Paused}, nil
}
func sameHash(left, right *string) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func (backup *Backups) prepareAssets(ctx context.Context, assets []Asset, revision string) error {
	cloud := NewAttachments(filepath.Join(backup.Directory, "attachments"))
	for _, asset := range assets {
		file, _, err := backup.Library.Open(asset.AssetID, &asset.Metadata)
		if err != nil {
			return err
		}
		filename := file.Name()
		file.Close()
		result, err := cloud.Import(ctx, filename, "附件", false)
		if err != nil {
			return err
		}
		if result.AssetID != asset.AssetID {
			return fmt.Errorf("备份附件摘要不一致")
		}
	}
	if len(assets) == 0 {
		return nil
	}
	directory := filepath.Join(backup.Directory, "attachment-manifests")
	if err := privateDirectory(directory); err != nil {
		return err
	}
	value, err := json.Marshal(map[string]any{"version": 1, "revision": revision, "assets": assets})
	if err != nil {
		return err
	}
	return writeBytes(filepath.Join(directory, revision+".json"), value)
}
func (backup *Backups) Enqueue(ctx context.Context, request BackupRequest, replace bool) (map[string]any, error) {
	if request.SourceRevision <= 0 || backup.Verify == nil {
		return map[string]any{"ok": false, "code": "stale-source", "error": "请先完成本机持久保存"}, nil
	}
	if err := backup.Verify(ctx, request); err != nil {
		return map[string]any{"ok": false, "code": "stale-source", "error": err.Error()}, nil
	}
	content, _, assets, err := WorkspaceJSON(request.Workspace)
	if err != nil {
		return nil, err
	}
	hash := digestBytes(content)
	backup.mu.Lock()
	defer backup.mu.Unlock()
	if err := backup.loadLocked(); err != nil {
		return nil, err
	}
	if backup.closed {
		return nil, fmt.Errorf("备份服务已关闭")
	}
	if request.SourceRevision < backup.settings.LastSourceRevision || request.SourceRevision == backup.settings.LastSourceRevision && backup.settings.LastSourceHash != nil && hash != *backup.settings.LastSourceHash {
		return map[string]any{"ok": false, "code": "stale-source"}, nil
	}
	if !request.Manual && !backup.settings.Auto {
		return map[string]any{"ok": false, "code": "disabled"}, nil
	}
	if backup.settings.Paused != nil && *backup.settings.Paused == "local-source" && request.ResumeSource {
		backup.settings.Paused = nil
	}
	if !request.Manual && backup.settings.Paused != nil {
		return map[string]any{"ok": false, "code": "paused"}, nil
	}
	request.Ticket = backup.settings.LastTicket + 1
	if backup.pending != nil {
		request.Ticket = max(request.Ticket, backup.pending.Ticket+1)
	}
	backup.pending = &request
	pending, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if err := writeBytes(filepath.Join(backup.Profile, "backup-pending.json"), pending); err != nil {
		return nil, err
	}
	result, err := backup.performLocked(ctx, request, content, assets, hash, replace)
	if err != nil {
		backup.settings.LastError = map[string]any{"code": "write-failed", "message": err.Error()}
		backup.persistLocked()
		if backup.settings.Auto && backup.settings.Paused == nil && backup.settings.RetryCount < 3 {
			delays := []time.Duration{5 * time.Second, 30 * time.Second, 120 * time.Second}
			delay := delays[backup.settings.RetryCount]
			backup.settings.RetryCount++
			backup.persistLocked()
			if backup.retry != nil {
				backup.retry.Stop()
			}
			backup.retry = time.AfterFunc(delay, func() {
				request.ResumeSource = true
				request.Manual = false
				backup.Enqueue(context.Background(), request, false)
			})
		}
		return nil, err
	}
	backup.lastResult = result
	if result["ok"] == true {
		backup.pending = nil
		os.Remove(filepath.Join(backup.Profile, "backup-pending.json"))
		backup.settings.RetryCount = 0
		if backup.retry != nil {
			backup.retry.Stop()
		}
	}
	return result, nil
}

func (backup *Backups) externalChangeLocked(current *string, ticket int64) (map[string]any, error) {
	backup.settings.Paused = pointer("external-change")
	backup.settings.LastError = map[string]any{"code": "external-change", "message": errBackupBaselineChanged.Error()}
	if backup.retry != nil {
		backup.retry.Stop()
		backup.retry = nil
	}
	if err := backup.persistLocked(); err != nil {
		return nil, err
	}
	return map[string]any{"ok": false, "code": "external-change", "revision": current, "ticket": ticket, "error": errBackupBaselineChanged.Error()}, nil
}

func (backup *Backups) performLocked(ctx context.Context, request BackupRequest, content []byte, assets []Asset, hash string, replace bool) (map[string]any, error) {
	if err := privateDirectory(backup.Directory); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(filepath.Join(backup.Directory, ".bike-mygo-backup.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, fmt.Errorf("备份文件正由另一个进程使用")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	existing, current, err := backup.Current()
	if err != nil {
		return nil, err
	}
	baseline := backup.settings.BaselineHash
	if replace {
		baseline = request.ExpectedFileHash
	}
	if !sameHash(current, baseline) && !(current != nil && *current == hash) {
		return backup.externalChangeLocked(current, request.Ticket)
	}
	if err := backup.prepareAssets(ctx, assets, hash); err != nil {
		return nil, err
	}
	// Keep the baseline approved before attachment preparation. AtomicFile's
	// own stat check covers changes after its later destination snapshot.
	latest := current
	checkCurrent := func() error {
		_, observed, err := backup.Current()
		if err != nil {
			return err
		}
		latest = observed
		if !sameHash(observed, current) {
			return errBackupBaselineChanged
		}
		return nil
	}
	stamp := strings.NewReplacer(":", "-", ".", "-").Replace(time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	if replace && existing != nil {
		if err := writeBytes(filepath.Join(backup.Directory, "bike-workspace-external-"+stamp+".json"), existing); err != nil {
			return nil, err
		}
	}
	var commitError error
	if current == nil || *current != hash {
		if request.Manual || time.Since(time.UnixMilli(backup.settings.LastStampAt)) >= 10*time.Minute {
			if err := writeBytes(filepath.Join(backup.Directory, "bike-workspace-"+stamp+".json"), content); err != nil {
				return nil, err
			}
			backup.settings.LastStampAt = time.Now().UnixMilli()
		}
		commitError = AtomicFile(ctx, filepath.Join(backup.Directory, "bike-workspace.json"), func(writer io.Writer) error {
			if _, err := writer.Write(content); err != nil {
				return err
			}
			return checkCurrent()
		})
	} else {
		commitError = checkCurrent()
	}
	// AtomicFile also detects changes while its temporary file is flushed.
	// Other write or durability failures retain their original error.
	if errors.Is(commitError, errFileTargetChanged) {
		_, latest, err = backup.Current()
		if err != nil {
			return nil, err
		}
		commitError = errBackupBaselineChanged
	}
	if errors.Is(commitError, errBackupBaselineChanged) {
		return backup.externalChangeLocked(latest, request.Ticket)
	}
	if commitError != nil {
		return nil, commitError
	}
	backup.settings.BaselineHash = pointer(hash)
	backup.settings.LastContentHash = pointer(hash)
	backup.settings.LastSourceHash = pointer(hash)
	backup.settings.LastSourceRevision = request.SourceRevision
	backup.settings.LastSemanticHash = pointer(request.SemanticHash)
	backup.settings.LastTicket = request.Ticket
	backup.settings.LastSuccessAt = pointer(time.Now().UTC().Format(time.RFC3339Nano))
	backup.settings.Paused = nil
	backup.settings.LastError = nil
	if err := backup.persistLocked(); err != nil {
		return nil, err
	}
	// Retention runs after the authoritative file and receipt are safely stored.
	backup.pruneLocked()
	return map[string]any{"ok": true, "code": "ok", "path": filepath.Join(backup.Directory, "bike-workspace.json"), "revision": hash, "ticket": request.Ticket}, nil
}
func (backup *Backups) pruneLocked() {
	entries, err := os.ReadDir(backup.Directory)
	if err != nil {
		return
	}
	type candidate struct {
		name string
		at   time.Time
	}
	files := []candidate{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "bike-workspace-") && strings.HasSuffix(entry.Name(), ".json") && entry.Type().IsRegular() {
			info, err := entry.Info()
			if err == nil {
				files = append(files, candidate{entry.Name(), info.ModTime()})
			}
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].at.After(files[j].at) })
	for index := 20; index < len(files); index++ {
		os.Remove(filepath.Join(backup.Directory, files[index].name))
	}
}
func (backup *Backups) Accept(ctx context.Context, hash string, request BackupRequest) (map[string]any, error) {
	if backup.Verify == nil || request.SourceRevision <= 0 {
		return nil, fmt.Errorf("缺少本机保存凭据")
	}
	if err := backup.Verify(ctx, request); err != nil {
		return nil, err
	}
	content, _, _, err := WorkspaceJSON(request.Workspace)
	if err != nil {
		return nil, err
	}
	backup.mu.Lock()
	defer backup.mu.Unlock()
	if err := backup.loadLocked(); err != nil {
		return nil, err
	}
	raw, current, err := backup.Current()
	if err != nil {
		return nil, err
	}
	if current == nil || *current != hash {
		return nil, fmt.Errorf("外部备份基线已变化")
	}
	normalized, _, _, err := WorkspaceJSON(raw)
	if err != nil {
		return nil, err
	}
	sourceHash := digestBytes(content)
	if sourceHash != digestBytes(normalized) || request.SourceRevision < backup.settings.LastSourceRevision {
		return nil, fmt.Errorf("备份与本机已保存内容不一致")
	}
	backup.settings.BaselineHash = pointer(hash)
	backup.settings.LastSourceHash = pointer(sourceHash)
	backup.settings.LastSourceRevision = request.SourceRevision
	backup.settings.LastSemanticHash = pointer(request.SemanticHash)
	backup.settings.LastTicket++
	backup.settings.Paused = nil
	backup.settings.LastError = nil
	if err := backup.persistLocked(); err != nil {
		return nil, err
	}
	backup.pending = nil
	os.Remove(filepath.Join(backup.Profile, "backup-pending.json"))
	return backup.statusLocked(), nil
}
func (backup *Backups) Load(ctx context.Context) (map[string]any, error) {
	raw, hash, err := backup.Current()
	if err != nil {
		return nil, err
	}
	if hash == nil {
		return nil, fmt.Errorf("尚无 MyGO iCloud 备份")
	}
	_, _, assets, err := WorkspaceJSON(raw)
	if err != nil {
		return nil, err
	}
	cloud := NewAttachments(filepath.Join(backup.Directory, "attachments"))
	for _, asset := range assets {
		file, _, err := cloud.Open(asset.AssetID, &asset.Metadata)
		if err != nil {
			return nil, err
		}
		name := file.Name()
		file.Close()
		if _, err := backup.Library.Import(ctx, name, "附件", true); err != nil {
			return nil, err
		}
	}
	return map[string]any{"payload": json.RawMessage(raw), "path": filepath.Join(backup.Directory, "bike-workspace.json"), "revision": *hash}, nil
}
