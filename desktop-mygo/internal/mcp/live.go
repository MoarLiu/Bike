package mcp

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

// LiveStore is a serialized, bounded client of the existing protocol-2 socket.
// It requests snapshots from the renderer and never substitutes a file store.
type LiveStore struct {
	connection     net.Conn
	reader         *bufio.Reader
	token          string
	discoveryPath  string
	closed         bool
	candidatePatch bool
	mu             sync.Mutex
}

func OpenLive(ctx context.Context, discoveryPath string) (*LiveStore, error) {
	stat, err := os.Lstat(discoveryPath)
	if err != nil {
		return nil, fmt.Errorf("Live 未启用，请在 Bike MyGO 中启用授权")
	}
	if !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 || stat.Size() > 4096 {
		return nil, fmt.Errorf("Live 发现文件权限无效，请在应用中重新启用服务")
	}
	if !ownedByCurrentUser(stat) {
		return nil, fmt.Errorf("Live 发现文件不属于当前用户")
	}
	file, err := os.Open(discoveryPath)
	if err != nil {
		return nil, fmt.Errorf("Live 发现文件无效")
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(stat, opened) || opened.Mode().Perm()&0077 != 0 || !ownedByCurrentUser(opened) {
		return nil, fmt.Errorf("Live 发现文件在读取时已变化")
	}
	raw, err := io.ReadAll(io.LimitReader(file, 4097))
	if err != nil || len(raw) > 4096 {
		return nil, fmt.Errorf("Live 发现文件无效")
	}
	var discovery struct {
		Protocol   int    `json:"protocol"`
		SocketPath string `json:"socketPath"`
		Token      string `json:"token"`
	}
	if err := json.Unmarshal(raw, &discovery); err != nil {
		return nil, fmt.Errorf("Live 发现协议无效")
	}
	decoded, err := hex.DecodeString(discovery.Token)
	if err != nil || len(decoded) != 32 || discovery.Protocol != 2 || discovery.SocketPath == "" || hex.EncodeToString(decoded) != discovery.Token {
		return nil, fmt.Errorf("Live 发现协议无效")
	}
	socketInfo, err := os.Lstat(discovery.SocketPath)
	if err != nil || socketInfo.Mode()&os.ModeSocket == 0 || !ownedByCurrentUser(socketInfo) {
		return nil, fmt.Errorf("Live socket 身份无效")
	}
	parent, err := os.Lstat(filepath.Dir(discovery.SocketPath))
	if err != nil || !parent.IsDir() || parent.Mode().Perm()&0077 != 0 || !ownedByCurrentUser(parent) {
		return nil, fmt.Errorf("Live socket 目录权限无效")
	}
	connection, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", discovery.SocketPath)
	if err != nil {
		return nil, fmt.Errorf("Live 已断开，请在应用中检查授权后重新连接")
	}
	return &LiveStore{connection: connection, reader: bufio.NewReader(connection), token: discovery.Token, discoveryPath: discoveryPath}, nil
}

func (store *LiveStore) Close() error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.closed = true
	if store.connection != nil {
		return store.connection.Close()
	}
	return nil
}
func (store *LiveStore) disconnect() {
	if store.connection != nil {
		store.connection.Close()
	}
	store.connection = nil
}

func (store *LiveStore) rpc(ctx context.Context, method string, payload *object) (*object, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if store.closed {
		return nil, fmt.Errorf("Live 连接已关闭")
	}
	if store.connection == nil {
		next, err := OpenLive(ctx, store.discoveryPath)
		if err != nil {
			return nil, err
		}
		if next.token != store.token {
			next.Close()
			return nil, fmt.Errorf("Live 授权已变化，请明确重新连接")
		}
		store.connection, store.reader = next.connection, next.reader
	}
	deadline := time.Now().Add(30 * time.Second)
	if at, ok := ctx.Deadline(); ok && at.Before(deadline) {
		deadline = at
	}
	if err := store.connection.SetDeadline(deadline); err != nil {
		store.disconnect()
		return nil, err
	}
	connection := store.connection
	stop := context.AfterFunc(ctx, func() { connection.Close() })
	defer stop()
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return nil, err
	}
	requestID := hex.EncodeToString(id)
	request := ordered("id", requestID, "token", store.token, "method", method, "payload", payload, "clientName", "Bike MyGO MCP stdio")
	encoded, err := contracts.Stringify(request, false, false)
	if err != nil {
		return nil, err
	}
	if len(encoded)+1 >= 80*1024*1024 {
		return nil, fmt.Errorf("Live 请求超过 80 MiB 处理预算")
	}
	if _, err := store.connection.Write(append(encoded, '\n')); err != nil {
		store.disconnect()
		return nil, fmt.Errorf("Live 已断开，请重新连接")
	}
	raw, err := readLine(store.reader, contracts.Limits.DocumentBytes+16*1024*1024)
	if err != nil {
		store.disconnect()
		return nil, fmt.Errorf("Live 响应中断、超时或超过预算，请重新连接")
	}
	var response struct {
		ID     string          `json:"id"`
		OK     bool            `json:"ok"`
		Error  string          `json:"error"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(raw, &response); err != nil || response.ID != requestID {
		store.disconnect()
		return nil, fmt.Errorf("Live 响应协议无效")
	}
	if !response.OK {
		return nil, fmt.Errorf("%s", response.Error)
	}
	parsed, err := contracts.ParseJSON(response.Result)
	if err != nil || asObject(parsed) == nil {
		store.disconnect()
		return nil, fmt.Errorf("Live 响应协议无效")
	}
	return asObject(parsed), nil
}

func (store *LiveStore) Load(ctx context.Context) (Snapshot, error) {
	snapshot := Snapshot{Live: true}
	result, err := store.rpc(ctx, "snapshot", contracts.NewObject())
	if err != nil {
		return snapshot, err
	}
	snapshot.Ordered = result.Child("workspace")
	store.mu.Lock()
	store.candidatePatch = false
	for _, capability := range result.Array("capabilities") {
		if capability == "candidate-patch-v1" {
			store.candidatePatch = true
		}
	}
	store.mu.Unlock()
	if snapshot.Ordered == nil || snapshot.Ordered.Get("version") != float64(3) || result.String("revision") == "" {
		return snapshot, fmt.Errorf("Live 工作区格式无效")
	}
	if _, ok := snapshot.Ordered.Get("documents").([]any); !ok {
		return snapshot, fmt.Errorf("Live 工作区格式无效")
	}
	snapshot.Workspace = contracts.ToPlain(snapshot.Ordered).(map[string]any)
	for _, raw := range snapshot.Workspace["documents"].([]any) {
		document, ok := raw.(map[string]any)
		if !ok {
			return snapshot, fmt.Errorf("Live 工作区格式无效")
		}
		nodes, ok := document["nodes"].([]any)
		if !ok {
			return snapshot, fmt.Errorf("Live 工作区格式无效")
		}
		if _, err := countNodes(nodes); err != nil {
			return snapshot, err
		}
	}
	snapshot.WorkspaceID = result.String("workspaceId")
	snapshot.Revision = result.String("revision")
	snapshot.DisplayPath = "运行中的 Bike 工作区"
	snapshot.Mode = "readonly"
	if result.Get("writable") == true {
		snapshot.Mode = "write"
	}
	// The existing socket serializes workspace with JSON.stringify. Retain those
	// bytes so Go's HTML escaping cannot inflate the JS-visible file.size.
	compact, err := contracts.Stringify(snapshot.Ordered, false, false)
	if err != nil {
		return snapshot, err
	}
	snapshot.Size = int64(len(compact))
	snapshot.ModifiedAt = result.String("savedAt")
	return snapshot, nil
}

func (store *LiveStore) Status(ctx context.Context, requestID string) (*object, error) {
	if requestID == "" || contracts.UTF16Length(requestID) > 200 {
		return nil, fmt.Errorf("requestId 无效")
	}
	return store.rpc(ctx, "status", ordered("requestId", requestID))
}

func (store *LiveStore) Mutate(ctx context.Context, operation string, args *object) (*object, error) {
	inputValue, err := contracts.Clone(args)
	if err != nil {
		return nil, err
	}
	input := asObject(inputValue)
	input.Delete("dryRun")
	input.Delete("requestId")
	expected := args.String("expectedRevision")
	digest, err := contracts.Digest(ordered("operation", operation, "expectedRevision", expected, "input", input))
	if err != nil {
		return nil, err
	}
	requestID := args.String("requestId")
	actual := args.Get("dryRun") == false
	if actual && requestID != "" {
		prior, err := store.Status(ctx, requestID)
		if err != nil {
			return nil, err
		}
		status := prior.String("status")
		if (status == "pending" || status == "committed" || status == "rejected" || status == "invalidated") && prior.String("clientDigest") != "" {
			if prior.String("clientDigest") != digest {
				return nil, fmt.Errorf("相同请求身份携带了不同内容")
			}
			prior.Set("requestId", requestID)
			prior.Set("applied", status == "committed")
			return prior, nil
		}
	}
	current, err := store.Load(ctx)
	if err != nil {
		return nil, err
	}
	if current.Revision != expected {
		return nil, fmt.Errorf("Live revision 已变化，请重新读取")
	}
	at := args.String("writeTimestamp")
	if at == "" {
		at = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	}
	draftValue, err := contracts.Clone(current.Ordered)
	if err != nil {
		return nil, err
	}
	draft := asObject(draftValue)
	preview, err := applyWrite(draft, operation, args, at)
	if err != nil {
		return nil, err
	}
	if requestID == "" {
		if actual {
			return nil, fmt.Errorf("Live 写入需要 dry-run 返回的 requestId，以便查询和安全重试")
		}
		requestID = strings.TrimPrefix(newID(""), "_")
	}
	reason := args.String("reason")
	payload := ordered("requestId", requestID, "operation", operation, "expectedRevision", expected, "workspaceId", current.WorkspaceID, "clientDigest", digest, "reason", reason, "dryRun", !actual)
	store.mu.Lock()
	supportsPatch := store.candidatePatch
	store.mu.Unlock()
	if supportsPatch {
		previous := map[string]string{}
		for _, raw := range current.Ordered.Array("documents") {
			document := asObject(raw)
			previous[document.String("id")], _ = contracts.Digest(document)
		}
		changed, order := []any{}, []any{}
		for _, raw := range draft.Array("documents") {
			document := asObject(raw)
			hash, err := contracts.Digest(document)
			if err != nil {
				return nil, err
			}
			order = append(order, document.String("id"))
			if hash != previous[document.String("id")] {
				changed = append(changed, document)
			}
		}
		payload.Set("candidatePatch", ordered("documents", changed, "documentOrder", order, "activeDocumentId", draft.String("activeDocumentId")))
	} else {
		payload.Set("candidate", draft)
		encoded, err := contracts.Stringify(payload, false, false)
		if err != nil {
			return nil, err
		}
		if len(encoded) > 4*1024*1024-4096 {
			return nil, fmt.Errorf("请将桌面应用升级到 2.0.1 后重试大文档 Live 写入")
		}
	}
	result, err := store.rpc(ctx, "proposal", payload)
	if err != nil {
		return nil, err
	}
	for _, key := range result.Keys {
		preview.Set(key, result.Get(key))
	}
	preview.Set("requestId", requestID)
	preview.Set("applied", false)
	preview.Set("dryRun", !actual)
	confirmation := preview.Child("confirmationArgs")
	confirmation.Set("expectedRevision", expected)
	confirmation.Set("dryRun", false)
	confirmation.Set("requestId", requestID)
	confirmation.Set("writeTimestamp", at)
	confirmation.Set("reason", reason)
	return preview, nil
}

func readLine(reader *bufio.Reader, budget int) ([]byte, error) {
	var result []byte
	for {
		part, err := reader.ReadSlice('\n')
		if len(result)+len(part) > budget {
			return nil, fmt.Errorf("response exceeds budget")
		}
		result = append(result, part...)
		if err == nil {
			return result, nil
		}
		if err != bufio.ErrBufferFull {
			return nil, io.ErrUnexpectedEOF
		}
	}
}
