//go:build darwin

package platform

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/egoist/mygo"
)

func prepareCloseWhenReady(ctx context.Context, subscribed func(context.Context) (bool, error), request func(context.Context) (json.RawMessage, error)) (bool, error) {
	poll := time.NewTicker(50 * time.Millisecond)
	defer poll.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		ready, err := subscribed(ctx)
		if err != nil {
			return false, err
		}
		if ready {
			raw, err := request(ctx)
			if err != nil {
				return false, err
			}
			var response struct {
				OK      bool `json:"ok"`
				Loading bool `json:"loading"`
			}
			if err := json.Unmarshal(raw, &response); err != nil {
				return false, err
			}
			if !response.Loading {
				return response.OK, nil
			}
		}
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-poll.C:
		}
	}
}

func (desktop *Desktop) PrepareClose(parent context.Context) bool {
	if desktop.current() == nil {
		return true
	}
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	ok, err := prepareCloseWhenReady(ctx, func(ctx context.Context) (bool, error) {
		window := desktop.current()
		if window == nil {
			return false, fmt.Errorf("Bike MyGO 窗口已关闭")
		}
		if !trustedNavigation(window.Page().URL()) {
			return false, nil
		}
		value, err := window.Page().EvalContext(ctx, "Boolean(window.__bikeMyGoCloseSubscribed)")
		if err != nil {
			// Navigation can replace the page while the bridge is starting.
			return false, ctx.Err()
		}
		ready, _ := value.(bool)
		return ready, nil
	}, func(ctx context.Context) (json.RawMessage, error) {
		return desktop.Request(ctx, "prepareUpdate", nil)
	})
	if desktop.current() == nil {
		return true
	}
	if err == nil && ok {
		desktop.mu.Lock()
		desktop.closeRejected = false
		desktop.mu.Unlock()
		os.Remove(filepath.Join(desktop.Profile, "close-recovery.json"))
		return true
	}
	message := "工作区正在编辑、同步或尚未完成保存，已保留窗口，请稍后重试"
	if err != nil {
		message = fmt.Sprintf("关闭前保存未完成：%s。窗口与恢复线索已保留", err)
	}
	receipt, _ := json.Marshal(map[string]any{"at": time.Now().UTC().Format(time.RFC3339Nano), "error": message})
	os.WriteFile(filepath.Join(desktop.Profile, "close-recovery.json"), receipt, 0600)
	desktop.Emit("updateState", map[string]any{"status": "idle", "currentVersion": desktop.Info.Version, "error": message})
	desktop.mu.Lock()
	previouslyRejected := desktop.closeRejected
	desktop.closeRejected = true
	desktop.mu.Unlock()
	// A first, responsive busy reply (for example composition in progress)
	// preserves the ordinary retry path. A repeated close or a broken/timed-out
	// bridge offers a native escape even when the renderer cannot recover.
	if err == nil && !previouslyRejected {
		desktop.Emit("updateState", map[string]any{"status": "idle", "currentVersion": desktop.Info.Version, "error": message + "；再次关闭可选择放弃未保存内容"})
		return false
	}
	choice, dialogError := mygo.Dialog.Message(mygo.MessageOptions{
		Parent: desktop.current(), Type: mygo.MessageWarning, Title: "关闭前尚未保存",
		Message: message, Detail: "可以返回窗口继续处理，或明确放弃尚未保存的输入。最近已保存的数据仍保留，强制关闭可能丢失本次未提交内容。",
		Buttons: []string{"返回窗口", "放弃未保存内容并关闭"}, CancelButton: 0,
	})
	return dialogError == nil && choice.Button == 1
}

func installMenu(desktop *Desktop) {
	edit := func(action string) func(*mygo.MenuItem, *mygo.Window) {
		return func(*mygo.MenuItem, *mygo.Window) { desktop.Emit("editCommand", action) }
	}
	mygo.App.SetMenu(mygo.NewMenu([]*mygo.MenuItem{
		{Label: desktop.Info.Name, Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleAbout},
			{Label: "检查 MyGO 更新…", Click: func(*mygo.MenuItem, *mygo.Window) { go desktop.checkUpdates(context.Background()) }},
			mygo.Separator(), {Label: "API 配置…", Accelerator: "CmdOrCtrl+,", Click: func(*mygo.MenuItem, *mygo.Window) { desktop.Emit("openApiConfig", nil) }},
			mygo.Separator(), {Role: mygo.RoleHide}, {Role: mygo.RoleHideOthers}, {Role: mygo.RoleUnhide}, mygo.Separator(), {Role: mygo.RoleQuit},
		}},
		{Label: "文件", Submenu: []*mygo.MenuItem{{Role: mygo.RoleClose}}},
		{Label: "编辑", Submenu: []*mygo.MenuItem{
			{Label: "撤销", Accelerator: "CmdOrCtrl+Z", Click: edit("undo")}, {Label: "重做", Accelerator: "CmdOrCtrl+Shift+Z", Click: edit("redo")}, mygo.Separator(),
			{Role: mygo.RoleCut}, {Role: mygo.RoleCopy}, {Role: mygo.RolePaste}, {Role: mygo.RoleSelectAll},
		}},
		{Label: "视图", Submenu: []*mygo.MenuItem{{Role: mygo.RoleToggleFullScreen}}}, {Role: mygo.RoleWindowMenu},
	}))
}
