package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/services"
)

func processBirth(pid int) string {
	if runtime.GOOS == "linux" {
		raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
		boot, bootErr := os.ReadFile("/proc/sys/kernel/random/boot_id")
		if err == nil && bootErr == nil {
			fields := strings.Fields(string(raw)[strings.LastIndex(string(raw), ")")+1:])
			if len(fields) > 19 {
				return "linux:" + strings.TrimSpace(string(boot)) + ":" + fields[19]
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "/bin/ps", "-p", fmt.Sprint(pid), "-o", "lstart=")
	command.Env = append(os.Environ(), "LC_ALL=C")
	output, err := command.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}

func writeTime(value string) (string, error) {
	value = contracts.TrimJS(value)
	if value == "" {
		return time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), nil
	}
	if !regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?Z$`).MatchString(value) {
		return "", fmt.Errorf("writeTimestamp 必须是 ISO 8601 UTC 时间，例如 2026-06-05T08:00:00.000Z")
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return "", fmt.Errorf("writeTimestamp 必须是 ISO 8601 UTC 时间，例如 2026-06-05T08:00:00.000Z")
	}
	return parsed.UTC().Format("2006-01-02T15:04:05.000Z"), nil
}
func hashRaw(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
func rawFile(name string) ([]byte, error) {
	file, err := os.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > int64(contracts.Limits.DocumentBytes) {
		return nil, fmt.Errorf("工作区文件无效或超过读取预算")
	}
	raw, err := io.ReadAll(io.LimitReader(file, int64(contracts.Limits.DocumentBytes)+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > contracts.Limits.DocumentBytes {
		return nil, fmt.Errorf("工作区文件超过读取预算")
	}
	return raw, nil
}

// Lock files share the Node MCP path, ownership fields, stale interval, and retry timeout.
func readWriteLock(name string) ([]byte, os.FileInfo, error) {
	file, err := os.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 4096 {
		return nil, nil, fmt.Errorf("工作区写入锁无效")
	}
	raw, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil {
		return nil, nil, err
	}
	if len(raw) > 4096 {
		return nil, nil, fmt.Errorf("工作区写入锁无效")
	}
	return raw, info, nil
}

func removeMatchingLock(name string, expected []byte) {
	latest, _, err := readWriteLock(name)
	if err == nil && string(latest) == string(expected) {
		os.Remove(name)
	}
}

func acquireFileLock(ctx context.Context, name string) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := os.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("工作区写入目标必须是普通文件")
	}
	lockPath := filepath.Join(filepath.Dir(name), "."+filepath.Base(name)+".lock")
	token := newID("lock")
	birth, hostname := processBirth(os.Getpid()), ""
	hostname, _ = os.Hostname()
	started := time.Now()
	for time.Since(started) <= 5*time.Second {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0600)
		if err == nil {
			value, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "ownerToken": token, "processBirth": birth, "hostname": hostname, "createdAt": time.Now().UTC().Format(time.RFC3339Nano), "workspacePath": filepath.Base(name)})
			_, writeErr := file.Write(value)
			if writeErr == nil {
				writeErr = file.Sync()
			}
			closeErr := file.Close()
			if writeErr == nil {
				writeErr = closeErr
			}
			if writeErr != nil {
				os.Remove(lockPath)
				return nil, writeErr
			}
			return func() {
				raw, _, readErr := readWriteLock(lockPath)
				if readErr != nil {
					return
				}
				var lock map[string]any
				if json.Unmarshal(raw, &lock) == nil && lock["ownerToken"] == token {
					removeMatchingLock(lockPath, raw)
				}
			}, nil
		}
		if !os.IsExist(err) {
			return nil, err
		}
		raw, info, readErr := readWriteLock(lockPath)
		if readErr != nil && !os.IsNotExist(readErr) {
			return nil, readErr
		}
		if readErr == nil {
			var lock map[string]any
			_ = json.Unmarshal(raw, &lock)
			if _, validOwner := lock["ownerToken"].(string); !validOwner {
				lock = nil
			}
			// Malformed stale files have no live owner, matching the JS recovery path.
			pid, _ := lock["pid"].(float64)
			alive := false
			validPID := pid > 0 && pid <= 2147483647 && pid == float64(int(pid))
			sameHost := lock["hostname"] == nil || lock["hostname"] == "" || lock["hostname"] == hostname
			if validPID {
				probe := syscall.Kill(int(pid), 0)
				alive = !sameHost || probe != syscall.ESRCH
				if prior, ok := lock["processBirth"].(string); alive && sameHost && ok && prior != "" {
					current := processBirth(int(pid))
					if current != "" && prior != current {
						alive = false
					}
				}
			}
			if validPID && !alive || !validPID && time.Since(info.ModTime()) >= 10*time.Minute {
				removeMatchingLock(lockPath, raw)
			}
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, fmt.Errorf("工作区正在被另一个 Bike MCP 写入，请稍后重试")
}
func previewWrite(snapshot Snapshot, operation string, args *object, at string) (*object, []byte, error) {
	if !writeTools[operation] {
		return nil, nil, fmt.Errorf("未知写入工具")
	}
	if args.String("expectedRevision") != snapshot.Revision {
		return nil, nil, fmt.Errorf("workspace revision 冲突，请重新读取工作区后再写入")
	}
	workspace, err := snapshotWorkspace(snapshot)
	if err != nil {
		return nil, nil, err
	}
	copy, err := contracts.Clone(workspace)
	if err != nil {
		return nil, nil, err
	}
	draft := asObject(copy)
	preview, err := applyWrite(draft, operation, args, at)
	if err != nil {
		return nil, nil, err
	}
	normalized, err := normalizeWorkspace(draft)
	if err != nil {
		return nil, nil, err
	}
	raw, err := contracts.Stringify(normalized, true, false)
	if err != nil {
		return nil, nil, err
	}
	raw = append(raw, '\n')
	if len(raw) > contracts.Limits.DocumentBytes {
		return nil, nil, fmt.Errorf("写入工作区超过 64 MiB")
	}
	reason := args.String("reason")
	confirmation := preview.Child("confirmationArgs")
	if reason != "" {
		confirmation.Set("reason", reason)
	}
	confirmation.Set("expectedRevision", snapshot.Revision)
	confirmation.Set("dryRun", false)
	confirmation.Set("writeTimestamp", at)
	result := ordered("operation", operation, "dryRun", args.Get("dryRun") != false, "applied", false, "mode", snapshot.Mode, "workspaceRevision", snapshot.Revision, "nextWorkspaceRevision", hashRaw(raw), "reason", reason)
	for _, key := range preview.Keys {
		result.Set(key, preview.Get(key))
	}
	if workspace.Get("version") == float64(3) {
		result.Set("mode", "readonly")
		result.Delete("confirmationArgs")
		result.Set("writeUnavailable", "2.0 工作区仅支持 Live 确认写入，File 模式只读")
	}
	if _, err := toolResult(result); err != nil {
		return nil, nil, err
	}
	return result, raw, nil
}
func (store FileStore) Mutate(ctx context.Context, operation string, args *object) (*object, error) {
	if contracts.TrimJS(args.String("expectedRevision")) == "" {
		return nil, fmt.Errorf("写入工具必须提供 expectedRevision")
	}
	at, err := writeTime(args.String("writeTimestamp"))
	if err != nil {
		return nil, err
	}
	actual := args.Get("dryRun") == false
	if actual && store.Mode == "write" {
		release, err := acquireFileLock(ctx, store.Path)
		if err != nil {
			return nil, err
		}
		defer release()
	}
	snapshot, err := store.Load(ctx)
	if err != nil {
		return nil, err
	}
	result, next, err := previewWrite(snapshot, operation, args, at)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !actual {
		return result, nil
	}
	if store.Mode != "write" {
		return nil, fmt.Errorf("Bike MCP 当前为 readonly 模式，拒绝真实写入")
	}
	if snapshot.Workspace["version"] == float64(3) {
		return nil, fmt.Errorf("2.0 工作区仅支持 Live 确认写入，File 模式只读")
	}
	current, err := rawFile(store.Path)
	if err != nil {
		return nil, err
	}
	if hashRaw(current) != snapshot.Revision {
		return nil, fmt.Errorf("workspace revision 冲突，请重新读取工作区后再写入")
	}
	directory := filepath.Join(filepath.Dir(store.Path), ".backups")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("备份目录无效")
	}
	if err := os.Chmod(directory, 0700); err != nil {
		return nil, err
	}
	stamp := strings.NewReplacer("-", "", ":", "", ".", "-").Replace(at)
	suffix := newID("backup")
	suffix = suffix[len(suffix)-8:]
	name := "bike-mcp-" + stamp + "-" + snapshot.Revision[:12] + "-" + operation + "-" + suffix + ".json"
	backupPath := filepath.Join(directory, name)
	backup, err := os.OpenFile(backupPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	_, err = backup.Write(current)
	if err == nil {
		err = backup.Sync()
	}
	closeErr := backup.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(backupPath)
		return nil, err
	}
	err = services.AtomicFile(ctx, store.Path, func(writer io.Writer) error {
		if _, err := writer.Write(next); err != nil {
			return err
		}
		latest, err := rawFile(store.Path)
		if err != nil {
			return err
		}
		if hashRaw(latest) != snapshot.Revision {
			return fmt.Errorf("workspace revision 冲突，请重新读取工作区后再写入")
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	result.Set("applied", true)
	result.Set("snapshot", ordered("filename", name, "path", filepath.Join(".backups", name), "pathIsRedacted", true, "createdAt", at))
	if err := pruneFileBackups(directory, name); err != nil {
		result.Set("backupWarning", "工作区已保存，旧备份清理未完成；最近的恢复副本已保留")
	}
	return result, nil
}
func pruneFileBackups(directory, keep string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	type candidate struct {
		name string
		size int64
		at   time.Time
	}
	files := []candidate{}
	for _, entry := range entries {
		if !entry.Type().IsRegular() || !strings.HasPrefix(entry.Name(), "bike-mcp-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		files = append(files, candidate{entry.Name(), info.Size(), info.ModTime()})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].name == keep {
			return true
		}
		if files[j].name == keep {
			return false
		}
		if !files[i].at.Equal(files[j].at) {
			return files[i].at.After(files[j].at)
		}
		return files[i].name > files[j].name
	})
	var size int64
	for index, file := range files {
		size += file.size
		if index > 0 && (index >= 20 || size > int64(contracts.Limits.DocumentBytes)) {
			if err := os.Remove(filepath.Join(directory, file.name)); err != nil {
				return err
			}
		}
	}
	return nil
}
