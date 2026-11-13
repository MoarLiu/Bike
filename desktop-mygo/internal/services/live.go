package services

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Grant struct {
	Scope       string   `json:"scope"`
	DocumentIDs []string `json:"documentIds"`
	Writable    bool     `json:"writable"`
}
type LiveServer struct {
	Directory string
	Command   string
	Handle    func(context.Context, map[string]any) (any, error)
	Revoke    func()
	mu        sync.Mutex
	lifecycle sync.Mutex
	listener  net.Listener
	cancel    context.CancelFunc
	temporary string
	token     string
	grant     Grant
	clients   map[net.Conn]bool
}

func (server *LiveServer) State() map[string]any {
	server.mu.Lock()
	defer server.mu.Unlock()
	return server.stateLocked()
}
func (server *LiveServer) stateLocked() map[string]any {
	ids := append([]string{}, server.grant.DocumentIDs...)
	var discovery any
	if server.listener != nil {
		discovery = filepath.Join(server.Directory, "live-mcp.json")
	}
	return map[string]any{"enabled": server.listener != nil, "writable": server.listener != nil && server.grant.Writable, "documentIds": ids, "discoveryPath": discovery, "command": server.Command, "args": []string{"--mcp-live"}}
}
func (server *LiveServer) Start(grant Grant) (map[string]any, error) {
	if grant.Scope != "workspace" && grant.Scope != "document" || grant.Scope == "document" && len(grant.DocumentIDs) == 0 || len(grant.DocumentIDs) > 1000 {
		return nil, fmt.Errorf("请选择有效文档授权范围")
	}
	seen := map[string]bool{}
	ids := []string{}
	for _, id := range grant.DocumentIDs {
		if id == "" || len([]rune(id)) > 200 {
			return nil, fmt.Errorf("请选择有效文档授权范围")
		}
		if !seen[id] {
			ids = append(ids, id)
			seen[id] = true
		}
	}
	grant.DocumentIDs = ids
	server.lifecycle.Lock()
	defer server.lifecycle.Unlock()
	server.stop()
	if err := privateDirectory(server.Directory); err != nil {
		return nil, err
	}
	if err := os.Chmod(server.Directory, 0700); err != nil {
		return nil, err
	}
	temporary, err := os.MkdirTemp("", "bike-mygo-live-")
	if err != nil {
		return nil, err
	}
	socket := filepath.Join(temporary, "bridge.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		os.RemoveAll(temporary)
		return nil, err
	}
	if err := os.Chmod(socket, 0600); err != nil {
		listener.Close()
		os.RemoveAll(temporary)
		return nil, err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		listener.Close()
		os.RemoveAll(temporary)
		return nil, err
	}
	token := hex.EncodeToString(secret)
	discovery, _ := json.Marshal(map[string]any{"protocol": 2, "socketPath": socket, "token": token})
	if err := writeBytes(filepath.Join(server.Directory, "live-mcp.json"), discovery); err != nil {
		listener.Close()
		os.RemoveAll(temporary)
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	server.mu.Lock()
	server.listener = listener
	server.cancel = cancel
	server.temporary = temporary
	server.token = token
	server.grant = grant
	server.clients = map[net.Conn]bool{}
	state := server.stateLocked()
	server.mu.Unlock()
	go server.accept(ctx, listener, grant, token)
	return state, nil
}
func (server *LiveServer) Stop() map[string]any {
	server.lifecycle.Lock()
	defer server.lifecycle.Unlock()
	server.stop()
	return server.State()
}
func (server *LiveServer) stop() {
	server.mu.Lock()
	listener, cancel, temporary, token := server.listener, server.cancel, server.temporary, server.token
	server.listener = nil
	server.cancel = nil
	server.temporary = ""
	server.token = ""
	server.grant = Grant{}
	if cancel != nil {
		cancel()
	}
	if listener != nil {
		listener.Close()
	}
	for connection := range server.clients {
		connection.Close()
	}
	server.clients = map[net.Conn]bool{}
	server.mu.Unlock()
	if token != "" {
		raw, err := readBounded(filepath.Join(server.Directory, "live-mcp.json"), 4096)
		if err == nil {
			var discovery map[string]any
			if json.Unmarshal(raw, &discovery) == nil && text(discovery, "token") == token {
				os.Remove(filepath.Join(server.Directory, "live-mcp.json"))
			}
		}
	}
	if temporary != "" {
		os.RemoveAll(temporary)
	}
	if server.Revoke != nil {
		server.Revoke()
	}
}
func (server *LiveServer) accept(ctx context.Context, listener net.Listener, grant Grant, token string) {
	for {
		connection, err := listener.Accept()
		if err != nil {
			return
		}
		server.mu.Lock()
		if server.listener != listener || len(server.clients) >= 8 {
			server.mu.Unlock()
			connection.Close()
			continue
		}
		server.clients[connection] = true
		server.mu.Unlock()
		go server.serve(ctx, connection, grant, token)
	}
}
func (server *LiveServer) serve(ctx context.Context, connection net.Conn, grant Grant, token string) {
	defer func() { connection.Close(); server.mu.Lock(); delete(server.clients, connection); server.mu.Unlock() }()
	reader := bufio.NewScanner(connection)
	reader.Buffer(make([]byte, 4096), 80*1024*1024)
	session := map[string]any{"id": identifier(), "clientName": "", "connectedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	var writes sync.Mutex
	inflight := make(chan struct{}, 4)
	var pending sync.WaitGroup
	defer pending.Wait()
	for {
		if !reader.Scan() {
			return
		}
		var request struct {
			ID         string          `json:"id"`
			Token      string          `json:"token"`
			Method     string          `json:"method"`
			Payload    json.RawMessage `json:"payload"`
			ClientName string          `json:"clientName"`
		}
		if json.Unmarshal(reader.Bytes(), &request) != nil || len(request.ID) == 0 || len(request.ID) > 200 || len(request.Token) != 64 || subtle.ConstantTimeCompare([]byte(request.Token), []byte(token)) != 1 || (request.Method != "snapshot" && request.Method != "proposal" && request.Method != "status") {
			return
		}
		select {
		case inflight <- struct{}{}:
		default:
			raw, _ := json.Marshal(map[string]any{"id": request.ID, "ok": false, "error": "Live 请求繁忙，请稍后重试"})
			writes.Lock()
			connection.SetWriteDeadline(time.Now().Add(30 * time.Second))
			_, err := connection.Write(append(raw, '\n'))
			writes.Unlock()
			if err != nil {
				return
			}
			continue
		}
		pending.Add(1)
		go func() {
			defer pending.Done()
			defer func() { <-inflight }()
			response := map[string]any{"id": request.ID, "ok": false}
			var policy struct {
				DryRun *bool `json:"dryRun"`
			}
			if len(request.Payload) == 0 || string(request.Payload) == "null" {
				request.Payload = json.RawMessage(`{}`)
			}
			json.Unmarshal(request.Payload, &policy)
			if request.Method == "proposal" && policy.DryRun != nil && !*policy.DryRun && !grant.Writable {
				response["error"] = "当前 Live 连接只读，请在应用内明确授权写入"
			} else {
				callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				defer cancel()
				client := map[string]any{"id": session["id"], "connectedAt": session["connectedAt"], "clientName": request.ClientName}
				result, err := server.Handle(callCtx, map[string]any{"method": request.Method, "payload": request.Payload, "grant": grant, "session": client})
				if err != nil {
					response["error"] = err.Error()
				} else if callCtx.Err() != nil {
					response["error"] = "Live 授权已撤销或请求超时"
				} else {
					response["ok"] = true
					response["result"] = result
				}
			}
			raw, err := json.Marshal(response)
			if err != nil || len(raw) > 80*1024*1024 {
				connection.Close()
				return
			}
			writes.Lock()
			defer writes.Unlock()
			connection.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err := connection.Write(append(raw, '\n')); err != nil {
				connection.Close()
			}
		}()
	}
}
