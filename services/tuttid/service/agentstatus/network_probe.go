package agentstatus

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/runtimecmd"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

// NetworkEndpointStatus is the verdict of probing a single endpoint: whether it
// was reachable and which URL answered (or was tried).
type NetworkEndpointStatus struct {
	Reachable  bool
	Endpoint   string
	ReasonCode string
}

// NetworkStatus splits connectivity into the links the agent actually needs,
// reported separately: the npm registry (install/upgrade path), the provider's
// API (run/login path), and the proxy in front of them. ProviderAPI is nil for
// providers with no known public endpoint or when the CLI is configured with a
// custom API key (so the default endpoint isn't what it talks to). Proxy is nil
// only if proxy resolution itself could not run.
type NetworkStatus struct {
	Registry    NetworkEndpointStatus
	ProviderAPI *NetworkEndpointStatus
	Proxy       *NetworkProxyStatus
}

// NetworkProxyStatus reports whether an HTTP proxy is in effect (from the
// HTTP(S)_PROXY env or the macOS system proxy), its host:port, and whether that
// proxy is reachable.
type NetworkProxyStatus struct {
	Configured bool
	URL        string
	Reachable  bool
	ReasonCode string
}

// networkProbeAttemptTimeout bounds each endpoint attempt so a blocked host fails
// over quickly. Connection refusals / DNS failures return well under this; only a
// black-holed network waits the full window.
const networkProbeAttemptTimeout = 1500 * time.Millisecond

// probeEndpoint issues a cheap HEAD request. Any HTTP response means the host was
// reached (even a 4xx/405 proves connectivity); only a transport-level failure
// counts as unreachable.
func (s Service) probeEndpoint(ctx context.Context, endpoint string) NetworkEndpointStatus {
	attemptCtx, cancel := context.WithTimeout(ctx, networkProbeAttemptTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(attemptCtx, http.MethodHead, endpoint, nil)
	if err != nil {
		return NetworkEndpointStatus{Reachable: false, Endpoint: endpoint, ReasonCode: "network_error"}
	}
	response, err := s.httpClient().Do(request)
	if err != nil {
		return NetworkEndpointStatus{Reachable: false, Endpoint: endpoint, ReasonCode: "network_error"}
	}
	_ = response.Body.Close()
	return NetworkEndpointStatus{Reachable: true, Endpoint: endpoint}
}

// probeRegistry checks the npm registry fallback chain; the first reachable
// registry wins. When none answer, it reports the primary registry as the host
// that could not be reached.
func (s Service) probeRegistry(ctx context.Context) NetworkEndpointStatus {
	for _, registry := range s.agentNPMRegistries() {
		if status := s.probeEndpoint(ctx, registry); status.Reachable {
			return status
		}
	}
	return NetworkEndpointStatus{
		Reachable:  false,
		Endpoint:   s.primaryAgentNPMRegistry(),
		ReasonCode: "network_error",
	}
}

// providerAPIEndpoint is the base URL the provider's CLI talks to at run/login
// time. Empty for providers without a known public endpoint (the API check is
// skipped for them).
func providerAPIEndpoint(provider string) string {
	switch provider {
	case agentprovider.Codex:
		return "https://api.openai.com"
	case agentprovider.ClaudeCode:
		return "https://api.anthropic.com"
	case agentprovider.Gemini:
		return "https://generativelanguage.googleapis.com"
	default:
		return ""
	}
}

// probeProviderAPI checks the provider's API endpoint, or returns nil when the
// provider has no known endpoint, or when the CLI is configured with a custom
// API key / endpoint (env or on-disk config) — in that case the user points at
// their own base URL/gateway, so probing the default endpoint would mislead.
func (s Service) probeProviderAPI(ctx context.Context, provider string) *NetworkEndpointStatus {
	endpoint := providerAPIEndpoint(provider)
	if endpoint == "" || s.providerUsesCustomConfig(provider) {
		return nil
	}
	status := s.probeEndpoint(ctx, endpoint)
	return &status
}

// probeProxy detects whether an HTTP proxy is in effect for outbound requests
// and, if so, whether it is reachable. Resolution mirrors the proxy the probe
// HTTP client itself uses (env first, then the macOS system proxy).
func (s Service) probeProxy(ctx context.Context) *NetworkProxyStatus {
	resolve := s.ResolveProxy
	if resolve == nil {
		resolve = runtimecmd.HTTPProxyFunc()
	}
	request, err := http.NewRequest(http.MethodHead, officialNPMRegistry, nil)
	if err != nil {
		return nil
	}
	proxyURL, err := resolve(request)
	if err != nil || proxyURL == nil {
		return &NetworkProxyStatus{Configured: false}
	}
	addr := proxyAddr(proxyURL)
	status := &NetworkProxyStatus{Configured: true, URL: addr}
	dialer := net.Dialer{Timeout: networkProbeAttemptTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		status.ReasonCode = "network_error"
		return status
	}
	_ = conn.Close()
	status.Reachable = true
	return status
}

// proxyAddr renders a proxy URL as host:port, inferring the default port from
// the scheme when none is given.
func proxyAddr(u *url.URL) string {
	if u.Port() != "" {
		return u.Host
	}
	if u.Scheme == "https" {
		return u.Hostname() + ":443"
	}
	return u.Hostname() + ":80"
}
