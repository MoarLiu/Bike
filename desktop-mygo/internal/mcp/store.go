package mcp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

type Store interface {
	Load(context.Context) (Snapshot, error)
}

type Snapshot struct {
	Live        bool
	Workspace   map[string]any
	Ordered     *contracts.Object
	WorkspaceID string
	Raw         []byte
	Revision    string
	DisplayPath string
	Mode        string
	Size        int64
	ModifiedAt  string
}

type FileStore struct {
	Path  string
	Mode  string
	cache *fileSnapshotCache
}

type fileSnapshotCache struct {
	mu        sync.Mutex
	revision  string
	workspace *object
}

func NewFileStore(path, mode string) FileStore {
	return FileStore{Path: path, Mode: mode, cache: &fileSnapshotCache{}}
}

func (store FileStore) Load(ctx context.Context) (Snapshot, error) {
	var snapshot Snapshot
	if err := ctx.Err(); err != nil {
		return snapshot, err
	}
	file, err := os.OpenFile(store.Path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return snapshot, fmt.Errorf("无法读取工作区文件")
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > int64(contracts.Limits.DocumentBytes) {
		return snapshot, fmt.Errorf("工作区文件无效或超过 64 MiB 读取预算，原文件已保留")
	}
	raw, err := io.ReadAll(io.LimitReader(file, int64(contracts.Limits.DocumentBytes)+1))
	if err != nil || len(raw) > contracts.Limits.DocumentBytes {
		return snapshot, fmt.Errorf("工作区文件无效或超过 64 MiB 读取预算，原文件已保留")
	}
	if err := ctx.Err(); err != nil {
		return snapshot, err
	}
	sum := sha256.Sum256(raw)
	snapshot.Revision = hex.EncodeToString(sum[:])
	if store.cache != nil {
		store.cache.mu.Lock()
		defer store.cache.mu.Unlock()
		if store.cache.revision == snapshot.Revision {
			snapshot.Ordered = store.cache.workspace
		}
	}
	if snapshot.Ordered == nil {
		parsed, parseError := contracts.ParseJSON(raw)
		if parseError != nil {
			return snapshot, fmt.Errorf("导入文件不是有效工作区")
		}
		snapshot.Ordered, err = normalizeWorkspace(asObject(parsed))
		if err != nil {
			return snapshot, err
		}
		if store.cache != nil {
			store.cache.revision = snapshot.Revision
			store.cache.workspace = snapshot.Ordered
		}
	}
	snapshot.Workspace = contracts.ToPlain(snapshot.Ordered).(map[string]any)
	snapshot.Raw = raw
	snapshot.DisplayPath = filepath.Base(store.Path)
	snapshot.Mode = "readonly"
	if store.Mode == "write" {
		snapshot.Mode = "write"
	}
	snapshot.Size = int64(len(raw))
	// Node fs.Stats.mtime rounds the underlying timestamp to milliseconds.
	snapshot.ModifiedAt = stat.ModTime().Round(time.Millisecond).UTC().Format("2006-01-02T15:04:05.000Z")
	return snapshot, nil
}

func summary(snapshot Snapshot) (*object, error) {
	version, versionPresent := snapshot.Workspace["version"]
	if !versionPresent {
		version = float64(1)
	}
	if version != float64(1) && version != float64(2) && version != float64(3) {
		return nil, fmt.Errorf("工作区版本暂不支持，原文件已保留")
	}
	documents, ok := snapshot.Workspace["documents"].([]any)
	if !ok {
		return nil, fmt.Errorf("导入文件不是有效工作区")
	}
	if len(documents) == 0 {
		return nil, fmt.Errorf("工作区至少需要一个文档")
	}
	active, _ := snapshot.Workspace["activeDocumentId"].(string)
	activeFound := false
	nodes := 0
	var latest time.Time
	hasLatest := false
	for index, entry := range documents {
		document, ok := entry.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("第 %d 个文档无法读取：导入文件不是有效文档；原文件已保留", index+1)
		}
		id, ok := document["id"].(string)
		if !ok || id == "" {
			return nil, fmt.Errorf("工作区导出需要稳定文档 ID")
		}
		items, ok := document["nodes"].([]any)
		if !ok {
			return nil, fmt.Errorf("第 %d 个文档无法读取：文档缺少有效主题数组，原文件已保留；原文件已保留", index+1)
		}
		count, err := countNodes(items)
		if err != nil {
			return nil, err
		}
		nodes += count
		if id == active {
			activeFound = true
		}
		if text, ok := document["updatedAt"].(string); ok {
			if at, ok := parseDocumentDate(text); ok && (!hasLatest || at.After(latest)) {
				latest = at
				hasLatest = true
			}
		}
	}
	if !activeFound {
		active = documents[0].(map[string]any)["id"].(string)
	}
	var updatedAt any
	if hasLatest && latest.UnixMilli() != 0 {
		updatedAt = latest.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return ordered("version", version, "activeDocumentId", active, "documentCount", len(documents), "nodeCount", nodes,
		"updatedAt", updatedAt, "revision", snapshot.Revision, "mode", snapshot.Mode,
		"workspacePath", snapshot.DisplayPath, "workspacePathIsRedacted", true,
		"file", ordered("size", snapshot.Size, "modifiedAt", snapshot.ModifiedAt)), nil
}

func countNodes(items []any) (int, error) {
	type frame struct {
		items []any
		depth int
	}
	stack := []frame{{items, 1}}
	count := 0
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if current.depth > contracts.Limits.DesktopDepth {
			return 0, fmt.Errorf("主题深度超过 %d 层，已停止处理并保留原数据", contracts.Limits.DesktopDepth)
		}
		count += len(current.items)
		if count > contracts.Limits.DocumentNodes {
			return 0, fmt.Errorf("主题数超过 100,000，已停止处理并保留原数据")
		}
		for _, item := range current.items {
			if node, ok := item.(map[string]any); ok {
				if children, ok := node["children"].([]any); ok && len(children) > 0 {
					stack = append(stack, frame{children, current.depth + 1})
				}
			}
		}
	}
	return count, nil
}
