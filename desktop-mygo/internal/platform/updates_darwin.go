//go:build darwin

package platform

import (
	"context"
	"github.com/egoist/mygo"
)

func (desktop *Desktop) checkUpdates(ctx context.Context) (map[string]any, error) {
	desktop.Emit("updateState", map[string]any{"status": "checking", "currentVersion": desktop.Info.Version})
	state, err := desktop.Network.CheckMyGoUpdate(ctx, desktop.Info.Version, desktop.Info.TagPrefix)
	if err != nil {
		desktop.Emit("updateState", map[string]any{"status": "error", "currentVersion": desktop.Info.Version, "error": err.Error()})
		return nil, err
	}
	desktop.Emit("updateState", state)
	if state["updateAvailable"] == true {
		result, err := mygo.Dialog.Message(mygo.MessageOptions{Parent: desktop.current(), Type: mygo.MessageInfo, Title: "Bike MyGO 更新", Message: "发现 MyGO 新版本 " + state["latestVersion"].(string), Detail: "当前开发构建使用手动 DMG 安装。保存工作区后可从 MyGO 专属发布页下载安装包。", Buttons: []string{"打开下载页", "稍后"}, CancelButton: 1})
		if err != nil {
			return nil, err
		}
		if result.Button == 0 {
			if err := mygo.Shell.OpenExternal(state["releaseUrl"].(string)); err != nil {
				return nil, err
			}
		}
	}
	return state, nil
}
