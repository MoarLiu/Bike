//go:build darwin

package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/product"
	"github.com/MoarLiu/Bike/desktop-mygo/internal/services"
	"github.com/egoist/mygo"
)

type DesktopEvent struct {
	Name    string `json:"name"`
	ID      string `json:"id,omitempty"`
	Payload any    `json:"payload"`
}

var desktopEvent = mygo.NewEvent[DesktopEvent]("bike:desktop")

type nativeBridge struct{ desktop *Desktop }

func BindDesktop(desktop *Desktop) { mygo.BindAs("Desktop", &nativeBridge{desktop}) }
func (bridge *nativeBridge) Invoke(ctx context.Context, method, payload string) (map[string]any, error) {
	return bridge.desktop.Invoke(ctx, method, payload)
}
func (bridge *nativeBridge) Reply(ctx context.Context, id, result, message string) error {
	return bridge.desktop.Reply(ctx, id, result, message)
}

type reply struct {
	result json.RawMessage
	err    error
}
type pendingReply struct {
	window  *mygo.Window
	channel chan reply
}

// Desktop is the single host boundary. Frontend adapters keep the existing
// BikeDesktopBridge surface, including cancellation and removable subscriptions.
type Desktop struct {
	Info            product.Info
	Profile         string
	Library         *services.Attachments
	Network         *services.Network
	Backup          *services.Backups
	Live            *services.LiveServer
	mu              sync.Mutex
	window          *mygo.Window
	uploadsReady    bool
	pending         map[string]pendingReply
	sequence        uint64
	imports         map[string]context.CancelFunc
	assetSync       context.CancelFunc
	openDirectories []string
	closeRejected   bool
}

func NewDesktop(info product.Info, profile, cloud string) *Desktop {
	desktop := &Desktop{Info: info, Profile: profile, Library: services.NewAttachments(filepath.Join(profile, "attachments")), Network: services.NewNetwork(), pending: map[string]pendingReply{}, imports: map[string]context.CancelFunc{}}
	desktop.Backup = services.NewBackups(profile, cloud, desktop.Library, desktop.verifySaved)
	command, _ := os.Executable()
	desktop.Live = &services.LiveServer{Directory: profile, Command: command, Handle: func(ctx context.Context, payload map[string]any) (any, error) {
		raw, err := desktop.Request(ctx, "liveMcpRequest", desktopJSONField(payload, "payload"))
		if err != nil {
			return nil, err
		}
		return json.RawMessage(raw), nil
	}, Revoke: func() { desktop.Emit("liveMcpRevoke", nil) }}
	return desktop
}
func (desktop *Desktop) SetWindow(window *mygo.Window) {
	desktop.mu.Lock()
	desktop.Library.CancelUploads()
	desktop.window = window
	desktop.uploadsReady = window != nil
	desktop.mu.Unlock()
}
func (desktop *Desktop) cancelUploads() {
	desktop.mu.Lock()
	defer desktop.mu.Unlock()
	desktop.uploadsReady = false
	desktop.Library.CancelUploads()
}
func (desktop *Desktop) current() *mygo.Window {
	desktop.mu.Lock()
	defer desktop.mu.Unlock()
	return desktop.window
}
func (desktop *Desktop) trusted(ctx context.Context) error {
	window := mygo.CallerWindow(ctx)
	if window == nil || window != desktop.current() || mygo.CallerPage(ctx) != window.Page() || !trustedNavigation(window.Page().URL()) {
		return fmt.Errorf("请求来源无效，请重新打开 Bike MyGO")
	}
	return nil
}
func (desktop *Desktop) Emit(name string, payload any) {
	if window := desktop.current(); window != nil {
		desktopEvent.Emit(window, DesktopEvent{Name: name, Payload: payload})
	}
}
func (desktop *Desktop) Request(ctx context.Context, name string, payload any) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	window := desktop.current()
	if window == nil {
		return nil, fmt.Errorf("Bike MyGO 窗口未就绪")
	}
	var id string
	channel := make(chan reply, 1)
	desktop.mu.Lock()
	if len(desktop.pending) >= 16 {
		desktop.mu.Unlock()
		return nil, fmt.Errorf("应用请求繁忙，请稍后重试")
	}
	desktop.sequence++
	id = fmt.Sprintf("%d", desktop.sequence)
	desktop.pending[id] = pendingReply{window, channel}
	desktop.mu.Unlock()
	defer func() { desktop.mu.Lock(); delete(desktop.pending, id); desktop.mu.Unlock() }()
	if err := desktopEvent.Emit(window, DesktopEvent{Name: name, ID: id, Payload: payload}); err != nil {
		return nil, err
	}
	select {
	case response := <-channel:
		return response.result, response.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
func (desktop *Desktop) Reply(ctx context.Context, id, result, message string) error {
	if err := desktop.trusted(ctx); err != nil {
		return err
	}
	if len(result) > 80*1024*1024 || len(message) > 2000 {
		return fmt.Errorf("应用响应超过预算")
	}
	desktop.mu.Lock()
	pending, exists := desktop.pending[id]
	desktop.mu.Unlock()
	if !exists || pending.window != mygo.CallerWindow(ctx) {
		return fmt.Errorf("应用请求已失效")
	}
	response := reply{result: json.RawMessage(result)}
	if message != "" {
		response.err = fmt.Errorf("%s", message)
	} else if !json.Valid(response.result) {
		return fmt.Errorf("应用响应不是有效 JSON")
	}
	select {
	case pending.channel <- response:
		return nil
	default:
		return fmt.Errorf("应用请求已回复")
	}
}
func (desktop *Desktop) configuration(ctx context.Context, kind string) (map[string]any, error) {
	key := `JSON.parse(localStorage.getItem("bike-sync-config")||"null")`
	if kind == "ai" {
		key = `JSON.parse(localStorage.getItem("bike-ai-config")||localStorage.getItem("local-outline-ai-config")||"null")`
	}
	window := desktop.current()
	if window == nil {
		return nil, fmt.Errorf("窗口未就绪")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	result, err := window.Page().EvalContext(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("服务配置读取失败")
	}
	configuration, _ := result.(map[string]any)
	return configuration, nil
}

const savedWorkspaceScript = `(async()=>{const database=await new Promise((resolve,reject)=>{const r=indexedDB.open('bike-db');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{return await new Promise((resolve,reject)=>{const t=database.transaction('workspace-store','readonly');const s=t.objectStore('workspace-store');const w=s.get('workspace'),m=s.get('workspace-meta');t.oncomplete=()=>resolve(JSON.stringify({workspace:w.result,revision:m.result?.revision}));t.onabort=t.onerror=()=>reject(t.error)})}finally{database.close()}})()`

func (desktop *Desktop) verifySaved(ctx context.Context, request services.BackupRequest) error {
	window := desktop.current()
	if window == nil {
		return fmt.Errorf("窗口未就绪")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	value, err := window.Page().EvalContext(ctx, savedWorkspaceScript)
	if err != nil {
		return fmt.Errorf("本机保存凭据读取失败")
	}
	encoded, ok := value.(string)
	if !ok {
		return fmt.Errorf("本机保存凭据无效")
	}
	var saved struct {
		Workspace json.RawMessage `json:"workspace"`
		Revision  int64           `json:"revision"`
	}
	if err := json.Unmarshal([]byte(encoded), &saved); err != nil {
		return err
	}
	expected, _, _, err := services.WorkspaceJSON(request.Workspace)
	if err != nil {
		return err
	}
	actual, _, _, err := services.WorkspaceJSON(saved.Workspace)
	if err != nil {
		return err
	}
	if window != desktop.current() || saved.Revision != request.SourceRevision || string(actual) != string(expected) {
		return fmt.Errorf("本机保存内容或版本已变化，请重新保存")
	}
	return nil
}
func desktopText(value map[string]any, key string) string {
	result, _ := value[key].(string)
	return result
}
func desktopNumber(value map[string]any, key string) int64 {
	number, _ := value[key].(float64)
	return int64(number)
}
func desktopStrings(value map[string]any, key string) ([]string, error) {
	list, ok := value[key].([]any)
	if !ok {
		return nil, fmt.Errorf("列表参数无效")
	}
	result := []string{}
	for _, item := range list {
		value, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("列表参数无效")
		}
		result = append(result, value)
	}
	return result, nil
}

func desktopRequestBudget(method string) int {
	if method == "exportWorkspaceArchive" {
		// Workspace and optional readable content have separate service budgets.
		return 2*contracts.Limits.DocumentBytes + contracts.Limits.OperationBytes
	}
	return contracts.Limits.DocumentBytes + contracts.Limits.OperationBytes
}

// JSON is carried as text across the strict JSON-v2 IPC codec, then parsed by
// the adapter. This preserves JS's isolated UTF-16 surrogates and property order.
func desktopJSONField(value map[string]any, key string) map[string]any {
	if raw, ok := value[key].(json.RawMessage); ok {
		value[key+"JSON"] = string(raw)
		delete(value, key)
	}
	return value
}

func quarantineAttachment(ctx context.Context, filename string) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	value := fmt.Sprintf("0083;%x;Bike MyGO;", time.Now().Unix())
	if err := exec.CommandContext(ctx, "/usr/bin/xattr", "-w", "com.apple.quarantine", value, filename).Run(); err != nil {
		return fmt.Errorf("附件已写入，但来源安全标记失败，已停止自动打开")
	}
	return nil
}

func (desktop *Desktop) Invoke(ctx context.Context, method, payload string) (result map[string]any, err error) {
	if err := desktop.trusted(ctx); err != nil {
		return nil, err
	}
	if len(payload) > desktopRequestBudget(method) {
		return nil, fmt.Errorf("桌面请求超过处理预算")
	}
	var request map[string]any
	if err := json.Unmarshal([]byte(payload), &request); err != nil {
		return nil, err
	}
	if request == nil {
		return nil, fmt.Errorf("桌面请求必须是对象")
	}
	if method == "invokeAiProvider" || method == "invokeSyncRequest" {
		var raw struct {
			Body json.RawMessage `json:"body"`
		}
		if err := json.Unmarshal([]byte(payload), &raw); err != nil {
			return nil, err
		}
		if raw.Body != nil {
			request["body"] = raw.Body
		}
	}
	defer func() {
		if err != nil {
			result = map[string]any{"ok": false, "status": 0, "error": err.Error()}
			err = nil
		} else if result == nil {
			result = map[string]any{"ok": true}
		} else if _, exists := result["ok"]; !exists {
			result["ok"] = true
		}
	}()
	switch method {
	case "info":
		encoded, _ := json.Marshal(desktop.Info)
		json.Unmarshal(encoded, &result)
		return result, nil
	case "invokeAiProvider":
		saved, err := desktop.configuration(ctx, "ai")
		if err != nil {
			return nil, err
		}
		result, err := desktop.Network.AI(ctx, request, saved)
		return desktopJSONField(result, "data"), err
	case "cancelAiRequest":
		desktop.Network.Cancel(desktopText(request, "requestId"))
		return nil, nil
	case "invokeSyncRequest":
		saved, err := desktop.configuration(ctx, "sync")
		if err != nil {
			return nil, err
		}
		result, err := desktop.Network.Sync(ctx, request, saved)
		return desktopJSONField(result, "data"), err
	case "getLiveMcpState":
		return desktop.Live.State(), nil
	case "startLiveMcp":
		var grant services.Grant
		if err := json.Unmarshal([]byte(payload), &grant); err != nil {
			return nil, err
		}
		return desktop.Live.Start(grant)
	case "stopLiveMcp":
		return desktop.Live.Stop(), nil
	case "getBackupStatus":
		return desktop.Backup.Status()
	case "setBackupAuto":
		return desktop.Backup.SetAuto(request["enabled"] == true)
	case "pauseBackup":
		return desktop.Backup.Pause("local-source")
	case "inspectBackup":
		return desktop.Backup.Inspect()
	case "loadICloudBackup":
		result, err := desktop.Backup.Load(ctx)
		return desktopJSONField(result, "payload"), err
	case "saveICloudBackup", "enqueueBackup", "replaceBackupWithLocal", "acceptBackupBaseline":
		var backup services.BackupRequest
		if err := json.Unmarshal([]byte(payload), &backup); err != nil {
			return nil, err
		}
		if method == "acceptBackupBaseline" {
			return desktop.Backup.Accept(ctx, desktopText(request, "hash"), backup)
		}
		if method == "saveICloudBackup" || method == "replaceBackupWithLocal" {
			backup.Manual = true
		}
		return desktop.Backup.Enqueue(ctx, backup, method == "replaceBackupWithLocal")
	case "scanAttachments":
		protected, err := desktopStrings(request, "protectedAssets")
		if err != nil {
			return nil, err
		}
		return desktop.Library.Scan(protected)
	case "cleanAttachments":
		protected, err := desktopStrings(request, "protectedAssets")
		if err != nil {
			return nil, err
		}
		return desktop.Library.Clean(protected, desktopText(request, "ticket"))
	case "readAttachment":
		return desktop.Library.Preview(desktopText(request, "assetId"), request["thumbnail"] != false)
	case "beginAttachmentUpload":
		desktop.mu.Lock()
		ready := desktop.uploadsReady
		desktop.mu.Unlock()
		if !ready {
			return nil, fmt.Errorf("附件传输页面已关闭，请重新打开后重试")
		}
		id := desktopText(request, "uploadId")
		err := desktop.Library.BeginUpload(ctx, id, desktopText(request, "name"), desktopNumber(request, "byteLength"))
		desktop.mu.Lock()
		ready = desktop.uploadsReady
		desktop.mu.Unlock()
		if !ready {
			desktop.Library.CancelUpload(id)
			return nil, fmt.Errorf("附件传输页面已关闭")
		}
		return nil, err
	case "writeAttachmentChunk":
		return nil, desktop.Library.UploadChunk(desktopText(request, "uploadId"), desktopNumber(request, "offset"), desktopText(request, "data"))
	case "finishAttachmentUpload":
		asset, err := desktop.Library.FinishUpload(ctx, desktopText(request, "uploadId"))
		return map[string]any{"asset": asset}, err
	case "cancelAttachmentUpload":
		desktop.Library.CancelUpload(desktopText(request, "uploadId"))
		return nil, nil
	case "importAttachments":
		return desktop.importFiles(ctx, request)
	case "cancelAttachmentImport":
		desktop.mu.Lock()
		if cancel := desktop.imports[desktopText(request, "requestId")]; cancel != nil {
			cancel()
		}
		desktop.mu.Unlock()
		return nil, nil
	case "saveAttachment":
		filename, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: mygo.CallerWindow(ctx), Title: "保存附件原件", DefaultPath: filepath.Base(desktopText(request, "name"))})
		if err != nil {
			return nil, err
		}
		if filename == "" {
			return map[string]any{"cancelled": true}, nil
		}
		if err := desktop.Library.CopyTo(ctx, desktopText(request, "assetId"), filename); err != nil {
			return nil, err
		}
		return map[string]any{"path": filename}, quarantineAttachment(ctx, filename)
	case "openAttachment":
		name := filepath.Base(desktopText(request, "name"))
		if name == "." || name == "" || strings.ContainsRune(name, 0) {
			return nil, fmt.Errorf("附件名称无效")
		}
		directory, err := os.MkdirTemp("", "bike-mygo-open-")
		if err != nil {
			return nil, err
		}
		filename := filepath.Join(directory, name)
		if err := desktop.Library.CopyTo(ctx, desktopText(request, "assetId"), filename); err != nil {
			os.RemoveAll(directory)
			return nil, err
		}
		if err := quarantineAttachment(ctx, filename); err != nil {
			os.RemoveAll(directory)
			return nil, err
		}
		desktop.mu.Lock()
		desktop.openDirectories = append(desktop.openDirectories, directory)
		desktop.mu.Unlock()
		return nil, mygo.Shell.OpenPath(filename)
	case "exportWorkspaceArchive":
		var archive struct {
			Workspace json.RawMessage    `json:"workspace"`
			Readable  *services.Readable `json:"readable"`
		}
		if err := json.Unmarshal([]byte(payload), &archive); err != nil {
			return nil, err
		}
		filename, err := mygo.Dialog.Save(mygo.SaveDialogOptions{Parent: mygo.CallerWindow(ctx), Title: "导出完整工作区 ZIP", DefaultPath: "bike-workspace.zip", Filters: []mygo.FileFilter{{Name: "Bike 工作区", Extensions: []string{"zip"}}}})
		if err != nil {
			return nil, err
		}
		if filename == "" {
			return map[string]any{"cancelled": true}, nil
		}
		return services.ExportArchive(ctx, filename, archive.Workspace, archive.Readable, desktop.Library)
	case "importWorkspaceArchive":
		selected, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Title: "载入工作区 ZIP", Filters: []mygo.FileFilter{{Name: "Bike 工作区", Extensions: []string{"zip"}}}})
		if err != nil {
			return nil, err
		}
		if len(selected) == 0 {
			return map[string]any{"cancelled": true}, nil
		}
		result, err := services.ImportArchive(ctx, selected[0], desktop.Library)
		return desktopJSONField(result, "workspace"), err
	case "syncAttachments":
		return desktop.syncAssets(ctx, request)
	case "cancelAttachmentSync":
		desktop.cancelAssetSync()
		return nil, nil
	case "checkForUpdates":
		return desktop.checkUpdates(ctx)
	default:
		return nil, fmt.Errorf("不支持的桌面方法 %s", method)
	}
}
func (desktop *Desktop) importFiles(ctx context.Context, request map[string]any) (map[string]any, error) {
	id := desktopText(request, "requestId")
	if id == "" || len(id) > 100 {
		return nil, fmt.Errorf("附件导入任务标识无效")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	desktop.mu.Lock()
	if _, exists := desktop.imports[id]; exists {
		desktop.mu.Unlock()
		return nil, fmt.Errorf("附件导入任务标识重复")
	}
	desktop.imports[id] = cancel
	desktop.mu.Unlock()
	defer func() { desktop.mu.Lock(); delete(desktop.imports, id); desktop.mu.Unlock() }()
	selected, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Title: "选择主题附件", Multiple: true})
	if err != nil {
		return nil, err
	}
	assets := []services.Asset{}
	failures := []map[string]any{}
	if len(selected) == 0 {
		return map[string]any{"cancelled": true, "assets": assets, "failures": failures}, nil
	}
	if len(selected) > contracts.Limits.ImportFiles {
		return nil, fmt.Errorf("单批最多选择 100 个文件")
	}
	var total int64
	for _, filename := range selected {
		info, err := os.Lstat(filename)
		if err != nil {
			return nil, err
		}
		total += info.Size()
	}
	if total > int64(contracts.Limits.ImportBytes) {
		return nil, fmt.Errorf("单批附件超过 512 MiB")
	}
	for _, filename := range selected {
		if err := ctx.Err(); err != nil {
			return map[string]any{"cancelled": true, "assets": assets, "failures": failures}, nil
		}
		asset, err := desktop.Library.Import(ctx, filename, "", false)
		if err != nil {
			failures = append(failures, map[string]any{"name": filepath.Base(filename), "error": err.Error()})
		} else {
			assets = append(assets, asset)
		}
	}
	return map[string]any{"assets": assets, "failures": failures}, nil
}
func (desktop *Desktop) Detach(window *mygo.Window) {
	desktop.mu.Lock()
	if desktop.window == window {
		desktop.window = nil
		desktop.uploadsReady = false
		desktop.Library.CancelUploads()
	}
	for id, pending := range desktop.pending {
		if pending.window == window {
			select {
			case pending.channel <- reply{err: fmt.Errorf("窗口已关闭")}:
			default:
			}
			delete(desktop.pending, id)
		}
	}
	for _, cancel := range desktop.imports {
		cancel()
	}
	desktop.mu.Unlock()
	desktop.Live.Stop()
	desktop.cancelAssetSync()
}
func (desktop *Desktop) Close() {
	desktop.cancelUploads()
	desktop.Backup.Close()
	desktop.Live.Stop()
	desktop.cancelAssetSync()
	desktop.mu.Lock()
	defer desktop.mu.Unlock()
	for _, cancel := range desktop.imports {
		cancel()
	}
	for _, directory := range desktop.openDirectories {
		os.RemoveAll(directory)
	}
}
