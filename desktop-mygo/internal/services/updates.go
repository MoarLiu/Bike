package services

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var releaseVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

func CompareVersions(left, right string) int {
	leftParts, rightParts := strings.Split(left, "."), strings.Split(right, ".")
	for index := 0; index < max(len(leftParts), len(rightParts)); index++ {
		a, b := 0, 0
		if index < len(leftParts) {
			a, _ = strconv.Atoi(leftParts[index])
		}
		if index < len(rightParts) {
			b, _ = strconv.Atoi(rightParts[index])
		}
		if a > b {
			return 1
		}
		if a < b {
			return -1
		}
	}
	return 0
}
func FindMyGoRelease(releases []any, prefix string) (map[string]any, error) {
	var selected map[string]any
	selectedVersion := ""
	for _, item := range releases {
		release, ok := item.(map[string]any)
		if !ok || release["draft"] == true || release["prerelease"] == true {
			continue
		}
		tag := text(release, "tag_name")
		if !strings.HasPrefix(tag, prefix) {
			continue
		}
		version := strings.TrimPrefix(tag, prefix)
		if !releaseVersionPattern.MatchString(version) {
			continue
		}
		if selected == nil || CompareVersions(version, selectedVersion) > 0 {
			selected = release
			selectedVersion = version
		}
	}
	if selected == nil {
		return nil, nil
	}
	page, err := url.Parse(text(selected, "html_url"))
	if err != nil || page.Scheme != "https" || page.Host != "github.com" || page.User != nil || !strings.HasPrefix(page.Path, "/MoarLiu/Bike/releases/tag/"+prefix) {
		return nil, fmt.Errorf("MyGO 发布页来源无效")
	}
	return map[string]any{"version": selectedVersion, "releaseUrl": page.String(), "tag": text(selected, "tag_name")}, nil
}
func (network *Network) CheckMyGoUpdate(ctx context.Context, current, prefix string) (map[string]any, error) {
	all := []any{}
	for page := 1; page <= 10; page++ {
		result, err := network.JSON(ctx, fmt.Sprintf("https://api.github.com/repos/MoarLiu/Bike/releases?per_page=100&page=%d", page), "GET", "", nil, 15*time.Second, 4*1024*1024, true)
		if err != nil {
			return nil, err
		}
		if result["ok"] != true {
			return nil, fmt.Errorf("MyGO 更新检查失败")
		}
		releases, ok := result["data"].([]any)
		if !ok {
			return nil, fmt.Errorf("MyGO 发布信息格式无效")
		}
		all = append(all, releases...)
		if len(releases) < 100 {
			break
		}
		if page == 10 {
			return nil, fmt.Errorf("发布历史超过查询预算，请打开 MyGO 发布页检查")
		}
	}
	release, err := FindMyGoRelease(all, prefix)
	if err != nil {
		return nil, err
	}
	state := map[string]any{"status": "not-available", "currentVersion": current, "updateAvailable": false, "form": "mygo", "tagPrefix": prefix, "installation": "manual"}
	if release != nil {
		state["latestVersion"] = release["version"]
		state["releaseUrl"] = release["releaseUrl"]
		if CompareVersions(release["version"].(string), current) > 0 {
			state["status"] = "available"
			state["updateAvailable"] = true
		}
	}
	return state, nil
}
