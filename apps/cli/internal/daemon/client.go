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
	AppID           string `json:"appId,omitempty"`
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

type apiErrorEnvelope struct {
	Error struct {
		Code             string `json:"code"`
		Reason           string `json:"reason"`
		Retryable        bool   `json:"retryable"`
		DeveloperMessage string `json:"developerMessage"`
		CorrelationID    string `json:"correlationId"`
	} `json:"error"`
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
			return newRequestError(ErrorDetails{ReasonCode: "daemon_request_invalid", Message: fmt.Sprintf("encode request body: %v", err)})
		}
		requestBody = bytes.NewReader(encoded)
	}

	url := client.baseURL + path
	request, err := http.NewRequestWithContext(ctx, method, url, requestBody)
	if err != nil {
		return newRequestError(ErrorDetails{ReasonCode: "daemon_request_invalid", Message: fmt.Sprintf("create daemon request: %v", err)})
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
		return newRequestError(ErrorDetails{ReasonCode: "daemon_response_read_failed", Message: fmt.Sprintf("read daemon response: %v", err)})
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return daemonResponseError(response.StatusCode, response.Status, content)
	}
	if result == nil {
		return nil
	}
	if err := json.Unmarshal(content, result); err != nil {
		return newRequestError(ErrorDetails{ReasonCode: "daemon_response_invalid", Message: fmt.Sprintf("decode daemon response: %v", err)})
	}
	return nil
}

func daemonResponseError(statusCode int, status string, content []byte) error {
	var envelope apiErrorEnvelope
	if err := json.Unmarshal(content, &envelope); err == nil {
		reasonCode := strings.TrimSpace(envelope.Error.Reason)
		if reasonCode == "" {
			reasonCode = strings.TrimSpace(envelope.Error.Code)
		}
		if reasonCode != "" {
			message := strings.TrimSpace(envelope.Error.DeveloperMessage)
			if message == "" {
				message = reasonCode
			}
			return newRequestError(ErrorDetails{
				ReasonCode: reasonCode, Message: message, Retryable: envelope.Error.Retryable,
				CorrelationID: strings.TrimSpace(envelope.Error.CorrelationID), StatusCode: statusCode,
			})
		}
	}
	if statusCode == http.StatusUnauthorized {
		return newRequestError(ErrorDetails{ReasonCode: "unauthorized", Message: "daemon authentication failed", StatusCode: statusCode})
	}
	message := strings.TrimSpace(string(content))
	if message == "" {
		message = strings.TrimSpace(status)
	}
	return newRequestError(ErrorDetails{
		ReasonCode: "daemon_request_failed", Message: "daemon request failed: " + message, StatusCode: statusCode,
	})
}

func daemonRequestError(err error) error {
	if errors.Is(err, context.Canceled) {
		return newRequestError(ErrorDetails{ReasonCode: "daemon_request_canceled", Message: "daemon request canceled"})
	}
	if errors.Is(err, context.DeadlineExceeded) || os.IsTimeout(err) {
		return newRequestError(ErrorDetails{ReasonCode: "daemon_request_timed_out", Message: "daemon request timed out", Retryable: true})
	}
	if runningInAgentEnvironment() {
		return newRequestError(ErrorDetails{
			ReasonCode: "daemon_unavailable", Retryable: true,
			Message: "daemon is not reachable from this agent execution environment; rerun the command in an execution environment with localhost/IPC access",
		})
	}
	return newRequestError(ErrorDetails{ReasonCode: "daemon_unavailable", Message: "daemon is not reachable", Retryable: true})
}

func runningInAgentEnvironment() bool {
	return strings.TrimSpace(os.Getenv("TUTTI_AGENT_SESSION_ID")) != "" ||
		strings.TrimSpace(os.Getenv("TUTTI_AGENT_ROUTING")) != ""
}

func urlPathEscape(value string) string {
	replacer := strings.NewReplacer("%", "%25", "/", "%2F", "?", "%3F", "#", "%23")
	return replacer.Replace(value)
}
