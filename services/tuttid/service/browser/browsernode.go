package browser

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
)

const browserNodeResponseLimit = 64 * 1024 * 1024

type browserNodeBackend interface {
	Call(context.Context, string, string, string, map[string]any) (ToolResult, error)
	ReleaseAgent(context.Context, string) error
}

func (b *browserNodeHTTPBackend) ReleaseAgent(ctx context.Context, agentSessionID string) error {
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return errors.New("BrowserNode Agent session ID is required")
	}
	info, err := b.readListenerInfo()
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]string{"agentSessionId": agentSessionID})
	if err != nil {
		return fmt.Errorf("encode BrowserNode Agent release: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+info.Address+"/v1/release-agent", bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("create BrowserNode Agent release request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+info.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := b.client.Do(request)
	if err != nil {
		return fmt.Errorf("BrowserNode desktop host is unavailable: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, browserNodeResponseLimit+1))
	if err != nil {
		return fmt.Errorf("read BrowserNode Agent release response: %w", err)
	}
	if len(body) > browserNodeResponseLimit {
		return errors.New("BrowserNode Agent release response is too large")
	}
	if response.StatusCode != http.StatusOK {
		var decoded browserNodeCallResponse
		_ = json.Unmarshal(body, &decoded)
		if decoded.Error != nil && strings.TrimSpace(decoded.Error.Message) != "" {
			return errors.New(decoded.Error.Message)
		}
		return errors.New("BrowserNode Agent release failed")
	}
	return nil
}

type browserNodeHTTPBackend struct {
	listenerInfoPath string
	client           *http.Client
}

type browserNodeListenerInfo struct {
	Address string `json:"address"`
	Token   string `json:"token"`
	Version int    `json:"version"`
}

type browserNodeCallResponse struct {
	Result *struct {
		ScreenshotData string `json:"screenshotData,omitempty"`
		Text           string `json:"text"`
	} `json:"result,omitempty"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func newBrowserNodeHTTPBackend(listenerInfoPath string) browserNodeBackend {
	return &browserNodeHTTPBackend{
		listenerInfoPath: strings.TrimSpace(listenerInfoPath),
		client:           httpx.Default(),
	}
}

func (b *browserNodeHTTPBackend) Call(ctx context.Context, workspaceID, agentSessionID, tool string, args map[string]any) (ToolResult, error) {
	info, err := b.readListenerInfo()
	if err != nil {
		return ToolResult{}, err
	}
	payload, err := json.Marshal(map[string]any{
		"agentSessionId": strings.TrimSpace(agentSessionID),
		"args":           args,
		"tool":           tool,
		"workspaceId":    strings.TrimSpace(workspaceID),
	})
	if err != nil {
		return ToolResult{}, fmt.Errorf("encode BrowserNode automation call: %w", err)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+info.Address+"/v1/call", bytes.NewReader(payload))
	if err != nil {
		return ToolResult{}, fmt.Errorf("create BrowserNode automation request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+info.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := b.client.Do(request)
	if err != nil {
		return ToolResult{}, fmt.Errorf("BrowserNode desktop host is unavailable: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, browserNodeResponseLimit+1))
	if err != nil {
		return ToolResult{}, fmt.Errorf("read BrowserNode automation response: %w", err)
	}
	if len(body) > browserNodeResponseLimit {
		return ToolResult{}, errors.New("BrowserNode automation response is too large")
	}
	var decoded browserNodeCallResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return ToolResult{}, fmt.Errorf("decode BrowserNode automation response: %w", err)
	}
	if response.StatusCode != http.StatusOK || decoded.Error != nil {
		message := "BrowserNode automation request failed"
		if decoded.Error != nil && strings.TrimSpace(decoded.Error.Message) != "" {
			message = decoded.Error.Message
		}
		return ToolResult{}, errors.New(message)
	}
	if decoded.Result == nil {
		return ToolResult{}, errors.New("BrowserNode automation response is missing a result")
	}

	result := ToolResult{Text: decoded.Result.Text}
	if decoded.Result.ScreenshotData == "" {
		return result, nil
	}
	if filePath, _ := args["filePath"].(string); strings.TrimSpace(filePath) != "" {
		image, err := base64.StdEncoding.DecodeString(decoded.Result.ScreenshotData)
		if err != nil {
			return ToolResult{}, fmt.Errorf("decode BrowserNode screenshot: %w", err)
		}
		if err := os.WriteFile(filePath, image, 0o600); err != nil {
			return ToolResult{}, fmt.Errorf("write BrowserNode screenshot: %w", err)
		}
		return result, nil
	}
	result.Images = []ToolImage{{Data: decoded.Result.ScreenshotData, MimeType: "image/png"}}
	return result, nil
}

func (b *browserNodeHTTPBackend) readListenerInfo() (browserNodeListenerInfo, error) {
	body, err := os.ReadFile(b.listenerInfoPath)
	if err != nil {
		return browserNodeListenerInfo{}, fmt.Errorf("BrowserNode desktop host is unavailable: %w", err)
	}
	var info browserNodeListenerInfo
	if err := json.Unmarshal(body, &info); err != nil {
		return browserNodeListenerInfo{}, fmt.Errorf("decode BrowserNode listener info: %w", err)
	}
	if info.Version != 1 || strings.TrimSpace(info.Token) == "" {
		return browserNodeListenerInfo{}, errors.New("BrowserNode listener info is invalid")
	}
	host, _, err := net.SplitHostPort(info.Address)
	if err != nil {
		return browserNodeListenerInfo{}, errors.New("BrowserNode listener address is invalid")
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return browserNodeListenerInfo{}, errors.New("BrowserNode listener must use a loopback address")
	}
	return info, nil
}
