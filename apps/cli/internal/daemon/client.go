package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	cliruntime "github.com/tutti-os/tutti/packages/cli/runtime"
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
	defaultClientTimeout = 360 * time.Second
	healthPath           = "/v1/health"
)

type HealthStatus struct {
	Service string `json:"service"`
	Status  string `json:"status"`
}

type CapabilityList = cliruntime.CapabilityList
type Capability = cliruntime.Capability
type CapabilityListOptions = cliruntime.CapabilityListOptions
type CapabilitySource = cliruntime.CapabilitySource
type CapabilityOutput = cliruntime.CapabilityOutput
type TableOutput = cliruntime.TableOutput
type TableColumn = cliruntime.TableColumn
type InvokeRequest = cliruntime.InvokeRequest
type InvokeContext = cliruntime.InvokeContext
type InvokeResponse = cliruntime.InvokeResponse
type CommandOutput = cliruntime.CommandOutput
type CommandWarning = cliruntime.CommandWarning

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

func (client *Client) ListCapabilities(ctx context.Context, workspaceID string, options CapabilityListOptions) (CapabilityList, error) {
	var result CapabilityList
	path := cliruntime.CapabilitiesRequestPath(workspaceID, options)
	if err := client.DoJSON(ctx, http.MethodGet, path, nil, &result); err != nil {
		return CapabilityList{}, err
	}
	return result, nil
}

func (client *Client) Invoke(ctx context.Context, commandID string, request InvokeRequest) (InvokeResponse, error) {
	var result InvokeResponse
	path := cliruntime.CommandInvokePath(commandID)
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
	if runningInAgentEnvironment() {
		return fmt.Errorf("daemon is not reachable from this agent execution environment; rerun the command in an execution environment with localhost/IPC access")
	}
	return fmt.Errorf("daemon is not reachable")
}

func runningInAgentEnvironment() bool {
	return strings.TrimSpace(os.Getenv("TUTTI_AGENT_SESSION_ID")) != "" ||
		strings.TrimSpace(os.Getenv("TUTTI_AGENT_ROUTING")) != ""
}
