package services

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/MoarLiu/Bike/desktop-mygo/internal/contracts"
)

type Network struct {
	Client    *http.Client
	mu        sync.Mutex
	active    map[string]context.CancelFunc
	cancelled map[string]time.Time
}

func NewNetwork() *Network {
	return &Network{Client: &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, active: map[string]context.CancelFunc{}, cancelled: map[string]time.Time{}}
}

func endpoint(raw string) (*url.URL, error) {
	value, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (value.Scheme != "http" && value.Scheme != "https") || value.Host == "" || value.User != nil {
		return nil, fmt.Errorf("服务地址需要使用有效的 HTTP 或 HTTPS 地址")
	}
	value.Fragment = ""
	value.Path = strings.TrimRight(value.Path, "/")
	return value, nil
}

func ValidateConfiguration(kind string, request, saved map[string]any) error {
	if saved == nil {
		return fmt.Errorf("请先保存服务配置后再发起请求")
	}
	field := "baseUrl"
	secret := "apiKey"
	if kind == "sync" {
		field, secret = "serverUrl", "token"
	}
	actual, err := endpoint(text(request, field))
	if err != nil {
		return err
	}
	expected, err := endpoint(text(saved, field))
	if err != nil {
		return err
	}
	if actual.String() != expected.String() {
		return fmt.Errorf("请求地址与已保存的服务配置不一致")
	}
	if strings.TrimSpace(text(request, secret)) != strings.TrimSpace(text(saved, secret)) || kind == "ai" && text(request, "endpoint") != text(saved, "endpoint") {
		return fmt.Errorf("请求与已保存的服务配置不一致")
	}
	return nil
}

func text(value map[string]any, name string) string { result, _ := value[name].(string); return result }

var syncRoutes = []struct {
	path    *regexp.Regexp
	methods string
}{
	{regexp.MustCompile(`^/api/v2/(status|checkpoint|events)$`), "GET"},
	{regexp.MustCompile(`^/api/v2/(enable|operations)$`), "POST"},
	{regexp.MustCompile(`^/api/v2/receipts/[^/]+$`), "GET"},
	{regexp.MustCompile(`^/api/sync/manifest$`), "GET PATCH"},
	{regexp.MustCompile(`^/api/documents$`), "GET"},
	{regexp.MustCompile(`^/api/documents/[^/]+/operations$`), "GET POST"},
	{regexp.MustCompile(`^/api/documents/[^/]+$`), "GET PUT DELETE"},
}

func SyncURL(request map[string]any) (string, string, error) {
	base, err := endpoint(text(request, "serverUrl"))
	if err != nil {
		return "", "", err
	}
	if base.RawQuery != "" || base.Fragment != "" || strings.Contains(text(request, "serverUrl"), "#") {
		return "", "", fmt.Errorf("同步服务地址不应包含查询参数或锚点")
	}
	raw := strings.TrimSpace(text(request, "pathname"))
	relative, err := url.Parse(raw)
	if err != nil || relative.IsAbs() || relative.Host != "" || !strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "//") || relative.Fragment != "" || strings.Contains(raw, "\\") {
		return "", "", fmt.Errorf("同步 API 路径无效")
	}
	if path.Clean(relative.Path) != relative.Path {
		return "", "", fmt.Errorf("同步 API 路径无效")
	}
	method := strings.ToUpper(text(request, "method"))
	if method == "" {
		method = "GET"
	}
	allowed := false
	for _, route := range syncRoutes {
		if route.path.MatchString(relative.Path) && strings.Contains(" "+route.methods+" ", " "+method+" ") {
			allowed = true
		}
	}
	if !allowed {
		return "", "", fmt.Errorf("同步 API 路径或方法不在允许范围内")
	}
	if relative.RawQuery != "" && relative.Path != "/api/v2/events" && relative.Path != "/api/v2/checkpoint" {
		return "", "", fmt.Errorf("同步分页路径无效")
	}
	query, err := url.ParseQuery(relative.RawQuery)
	if err != nil {
		return "", "", fmt.Errorf("同步分页参数无效")
	}
	digits := regexp.MustCompile(`^[0-9]{1,16}$`)
	for key, values := range query {
		if key != "after" && key != "limit" && key != "expectedCursor" {
			return "", "", fmt.Errorf("同步分页参数无效")
		}
		for _, value := range values {
			if !digits.MatchString(value) {
				return "", "", fmt.Errorf("同步分页参数无效")
			}
		}
	}
	return strings.TrimRight(base.String(), "/") + relative.String(), method, nil
}

func (network *Network) JSON(ctx context.Context, rawURL, method, token string, body any, timeout time.Duration, maximum int, requireJSON bool) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var content io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		if len(encoded) > contracts.Limits.DocumentBytes {
			return nil, fmt.Errorf("请求超过工作区预算")
		}
		content = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, rawURL, content)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	}
	response, err := network.Client.Do(request)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("请求超时，已停止等待")
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("请求已取消")
		}
		return nil, fmt.Errorf("网络请求失败")
	}
	defer response.Body.Close()
	if response.ContentLength > int64(maximum) {
		return nil, fmt.Errorf("响应超过读取预算")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, int64(maximum)+1))
	if err != nil {
		return nil, fmt.Errorf("响应读取失败或请求已取消")
	}
	if len(raw) > maximum {
		return nil, fmt.Errorf("响应超过读取预算")
	}
	var data any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &data); err != nil {
			if requireJSON && response.StatusCode >= 200 && response.StatusCode < 300 {
				return nil, fmt.Errorf("同步服务返回了无效 JSON")
			}
			data = map[string]any{"text": string(raw)}
		}
	}
	ok := response.StatusCode >= 200 && response.StatusCode < 300
	result := map[string]any{"ok": ok, "status": response.StatusCode, "data": data}
	if !ok {
		result["error"] = providerError(data, response.StatusCode)
	}
	if !requireJSON && ok && strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "text/html") {
		return nil, fmt.Errorf("AI 端点返回了 HTML 页面，请检查 API baseurl 和协议端点是否匹配")
	}
	return result, nil
}

func providerError(value any, status int) string {
	if data, ok := value.(map[string]any); ok {
		if nested, ok := data["error"].(map[string]any); ok && text(nested, "message") != "" {
			return text(nested, "message")
		}
		for _, key := range []string{"error", "detail", "message"} {
			if value := text(data, key); value != "" {
				return value
			}
		}
	}
	return fmt.Sprintf("请求失败：HTTP %d", status)
}

func (network *Network) Cancel(id string) {
	network.mu.Lock()
	defer network.mu.Unlock()
	network.cancelled[id] = time.Now().Add(2 * time.Minute)
	if cancel := network.active[id]; cancel != nil {
		cancel()
	}
}

func (network *Network) AI(ctx context.Context, request, saved map[string]any) (map[string]any, error) {
	if err := ValidateConfiguration("ai", request, saved); err != nil {
		return nil, err
	}
	id := text(request, "requestId")
	if id == "" || len(id) > 100 || strings.TrimSpace(text(request, "apiKey")) == "" {
		return nil, fmt.Errorf("AI 请求编号或 API key 无效")
	}
	base, err := endpoint(text(request, "baseUrl"))
	if err != nil {
		return nil, err
	}
	route := text(request, "endpoint")
	if route != "chat_completions" && route != "responses" {
		return nil, fmt.Errorf("AI 协议端点无效")
	}
	if !strings.HasSuffix(strings.ToLower(base.Path), "/chat/completions") && !strings.HasSuffix(strings.ToLower(base.Path), "/responses") {
		suffix := "responses"
		if route == "chat_completions" {
			suffix = "chat/completions"
		}
		base.Path = strings.TrimRight(base.Path, "/") + "/" + suffix
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	network.mu.Lock()
	for key, expiry := range network.cancelled {
		if time.Now().After(expiry) {
			delete(network.cancelled, key)
		}
	}
	if _, exists := network.active[id]; exists {
		network.mu.Unlock()
		return nil, fmt.Errorf("AI 请求已在进行中")
	}
	if _, exists := network.cancelled[id]; exists {
		network.mu.Unlock()
		return nil, fmt.Errorf("AI 请求已取消")
	}
	network.active[id] = cancel
	network.mu.Unlock()
	defer func() {
		network.mu.Lock()
		delete(network.active, id)
		delete(network.cancelled, id)
		network.mu.Unlock()
	}()
	return network.JSON(ctx, base.String(), "POST", text(request, "apiKey"), request["body"], time.Duration(contracts.Limits.AITimeoutMS)*time.Millisecond, contracts.Limits.AIResponseBytes, false)
}

func (network *Network) Sync(ctx context.Context, request, saved map[string]any) (map[string]any, error) {
	if err := ValidateConfiguration("sync", request, saved); err != nil {
		return nil, err
	}
	target, method, err := SyncURL(request)
	if err != nil {
		return nil, err
	}
	budget := contracts.Limits.SyncResponseBytes
	if strings.Contains(target, "/api/v2/checkpoint") {
		budget = contracts.Limits.OperationLimits.CheckpointBytes
	}
	return network.JSON(ctx, target, method, text(request, "token"), request["body"], time.Duration(contracts.Limits.SyncTimeoutMS)*time.Millisecond, budget, true)
}
