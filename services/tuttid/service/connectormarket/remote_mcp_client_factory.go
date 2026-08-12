package connectormarket

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
	"github.com/tutti-os/tutti/packages/connector/runtime/mcp"
)

type DirectRemoteMCPClientFactoryConfig struct {
	BaseURL                 string
	HTTPClient              *http.Client
	Timeout                 time.Duration
	MaxResponseBytes        int
	AuthorizeAccountRequest func(*http.Request, string) error
}

// DirectRemoteMCPClientFactory is the Tuttid product adapter for remote MCP.
// It connects directly to the configured Tutti Gateway and reads account
// authorization through the daemon-owned authorizer on every request.
type DirectRemoteMCPClientFactory struct {
	base                    *url.URL
	httpClient              *http.Client
	timeout                 time.Duration
	maxResponseBytes        int
	authorizeAccountRequest func(*http.Request, string) error
}

func NewDirectRemoteMCPClientFactory(config DirectRemoteMCPClientFactoryConfig) (*DirectRemoteMCPClientFactory, error) {
	base, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil || base.Scheme == "" || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("remote MCP Gateway base URL is unavailable")
	}
	if config.AuthorizeAccountRequest == nil {
		return nil, errors.New("remote MCP account authorizer is unavailable")
	}
	if config.Timeout <= 0 {
		config.Timeout = 30 * time.Second
	}
	if config.MaxResponseBytes <= 0 {
		config.MaxResponseBytes = 4 * 1024 * 1024
	}
	return &DirectRemoteMCPClientFactory{
		base: base, httpClient: config.HTTPClient, timeout: config.Timeout,
		maxResponseBytes: config.MaxResponseBytes, authorizeAccountRequest: config.AuthorizeAccountRequest,
	}, nil
}

func (factory *DirectRemoteMCPClientFactory) NewRemoteMCPClient(
	_ context.Context,
	request implementationhost.RemoteMCPClientRequest,
) (implementationhost.RemoteMCPClient, error) {
	if factory == nil || factory.base == nil || factory.authorizeAccountRequest == nil {
		return nil, errors.New("remote MCP client factory is unavailable")
	}
	connectorKey := strings.TrimSpace(request.ConnectorKey)
	accountID := strings.TrimSpace(request.AccountID)
	if connectorKey == "" || accountID == "" {
		return nil, errors.New("remote MCP route identity is invalid")
	}
	endpoint, err := url.JoinPath(factory.base.String(), "v1", "connectors", connectorKey, "mcp")
	if err != nil {
		return nil, errors.New("build remote MCP Gateway endpoint")
	}
	return mcp.NewModernStreamableHTTPClient(mcp.ModernStreamableHTTPClientConfig{
		Endpoint: endpoint, AllowedHosts: []string{factory.base.Hostname()},
		ConnectorVersion: strings.TrimSpace(request.Version), HTTPClient: factory.httpClient,
		AuthorizeRequest: func(httpRequest *http.Request) error {
			return factory.authorizeAccountRequest(httpRequest, accountID)
		},
		Timeout: factory.timeout, MaxResponseBytes: factory.maxResponseBytes,
	})
}
