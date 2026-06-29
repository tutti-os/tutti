package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

const (
	// 覆盖最长的命令预算(如 vibe-design session-start 声明 timeoutMs=300000),
	// 留出网络/排队余量,避免长命令在客户端侧误报 "daemon request timed out"。
	// TODO: 改为按命令的 timeoutMs 透传后,此全局值可回落。
	defaultClientTimeout    = 360 * time.Second
	healthPath              = "/v1/health"
	cliCapabilitiesPath     = "/v1/cli/capabilities"
	cliCommandInvokePattern = "/v1/cli/commands/{commandID}/invoke"
)

type HealthStatus struct {
	Service string `json:"service"`
	Status  string `json:"status"`
}

type CapabilityList struct {
	Commands []Capability `json:"commands"`
}

type Capability struct {
	ID          string           `json:"id"`
	Path        []string         `json:"path"`
	Summary     string           `json:"summary"`
	Description string           `json:"description,omitempty"`
	Visibility  string           `json:"visibility,omitempty"`
	InputSchema map[string]any   `json:"inputSchema,omitempty"`
	Output      CapabilityOutput `json:"output"`
	Source      CapabilitySource `json:"source"`
}

type CapabilityListOptions struct {
	IncludeHidden      bool
	IncludeIntegration bool
}

type CapabilitySource struct {
	Kind              string `json:"kind"`
	AppID             string `json:"appId,omitempty"`
	AppName           string `json:"appName,omitempty"`
	CLIDescription    string `json:"cliDescription,omitempty"`
	AppDescription    string `json:"appDescription,omitempty"`
	DocumentationFile string `json:"documentationFile,omitempty"`
	DocumentationPath string `json:"documentationPath,omitempty"`
}

type CapabilityOutput struct {
	DefaultMode string `json:"defaultMode"`
	JSON        bool   `json:"json"`
	Table       *struct {
		Columns []TableColumn `json:"columns"`
	} `json:"table"`
}

type TableColumn struct {
	Key   string `json:"key"`
	Label string `json:"label"`
}

type InvokeRequest struct {
	Input      map[string]any `json:"input,omitempty"`
	OutputMode string         `json:"outputMode,omitempty"`
	Context    InvokeContext  `json:"context"`
}

type InvokeContext struct {
	Source          string `json:"source"`
	WorkspaceID     string `json:"workspaceID,omitempty"`
	ParentCommandID string `json:"parentCommandId,omitempty"`
	AgentSessionID  string `json:"agentSessionId,omitempty"`
}

type InvokeResponse struct {
	OK     bool           `json:"ok"`
	Output *CommandOutput `json:"output,omitempty"`
}

type CommandOutput struct {
	Kind     string           `json:"kind"`
	Columns  []TableColumn    `json:"columns,omitempty"`
	Rows     []map[string]any `json:"rows,omitempty"`
	Value    map[string]any   `json:"value,omitempty"`
	Text     string           `json:"text,omitempty"`
	Warnings []CommandWarning `json:"warnings,omitempty"`
}

type CommandWarning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func NewClient(endpoint Endpoint) (*Client, error) {
	baseURL, err := endpoint.BaseURL()
	if err != nil {
		return nil, err
	}
	return &Client{
		baseURL: baseURL,
		token:   endpoint.Token,
		httpClient: &http.Client{
			Timeout: defaultClientTimeout,
		},
	}, nil
}

func (client *Client) GetHealth(ctx context.Context) (HealthStatus, error) {
	var result HealthStatus
	if err := client.DoJSON(ctx, http.MethodGet, healthPath, nil, &result); err != nil {
		return HealthStatus{}, err
	}
	return result, nil
}

func (client *Client) ListCapabilities(ctx context.Context) (CapabilityList, error) {
	return client.ListCapabilitiesForWorkspace(ctx, "")
}

func (client *Client) ListCapabilitiesForWorkspace(ctx context.Context, workspaceID string) (CapabilityList, error) {
	return client.ListCapabilitiesForWorkspaceWithHidden(ctx, workspaceID, false)
}

func (client *Client) ListCapabilitiesForWorkspaceWithHidden(ctx context.Context, workspaceID string, includeHidden bool) (CapabilityList, error) {
	return client.ListCapabilitiesForWorkspaceWithOptions(ctx, workspaceID, CapabilityListOptions{IncludeHidden: includeHidden})
}

func (client *Client) ListCapabilitiesForWorkspaceWithOptions(ctx context.Context, workspaceID string, options CapabilityListOptions) (CapabilityList, error) {
	var result CapabilityList
	path := cliCapabilitiesPath
	query := url.Values{}
	if strings.TrimSpace(workspaceID) != "" {
		query.Set("workspaceID", strings.TrimSpace(workspaceID))
	}
	if options.IncludeHidden {
		query.Set("includeHidden", "true")
	}
	if options.IncludeIntegration {
		query.Set("includeIntegration", "true")
	}
	if len(query) > 0 {
		path += "?" + query.Encode()
	}
	if err := client.DoJSON(ctx, http.MethodGet, path, nil, &result); err != nil {
		return CapabilityList{}, err
	}
	return result, nil
}

func (client *Client) Invoke(ctx context.Context, commandID string, request InvokeRequest) (InvokeResponse, error) {
	var result InvokeResponse
	path := strings.Replace(cliCommandInvokePattern, "{commandID}", urlPathEscape(commandID), 1)
	if err := client.DoJSON(ctx, http.MethodPost, path, request, &result); err != nil {
		return InvokeResponse{}, err
	}
	return result, nil
}

func (client *Client) DoJSON(ctx context.Context, method string, path string, body any, result any) error {
	var requestBody io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode request body: %w", err)
		}
		requestBody = bytes.NewReader(encoded)
	}

	url := client.baseURL + path
	request, err := http.NewRequestWithContext(ctx, method, url, requestBody)
	if err != nil {
		return fmt.Errorf("create daemon request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+client.token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}

	response, err := client.httpClient.Do(request)
	if err != nil {
		return daemonRequestError(err)
	}
	defer response.Body.Close()

	content, err := io.ReadAll(response.Body)
	if err != nil {
		return fmt.Errorf("read daemon response: %w", err)
	}
	if response.StatusCode == http.StatusUnauthorized {
		return fmt.Errorf("daemon authentication failed")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		message := strings.TrimSpace(string(content))
		if message == "" {
			message = response.Status
		}
		return fmt.Errorf("daemon request failed: %s", message)
	}
	if result == nil {
		return nil
	}
	if err := json.Unmarshal(content, result); err != nil {
		return fmt.Errorf("decode daemon response: %w", err)
	}
	return nil
}

func daemonRequestError(err error) error {
	if errors.Is(err, context.Canceled) {
		return fmt.Errorf("daemon request canceled")
	}
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
		return fmt.Errorf("daemon request timed out")
	}
	return fmt.Errorf("daemon is not reachable")
}

func urlPathEscape(value string) string {
	replacer := strings.NewReplacer("%", "%25", "/", "%2F", "?", "%3F", "#", "%23")
	return replacer.Replace(value)
}
