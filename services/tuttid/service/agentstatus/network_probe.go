package agentstatus

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"time"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/runtimecmd"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

// logNetworkProbe records each provider's network probe outcome so a confusing
// "service API unreachable but the agent works" report is diagnosable from logs.
func logNetworkProbe(
	provider string,
	registry NetworkEndpointStatus,
	api *NetworkEndpointStatus,
	proxy *NetworkProxyStatus,
) {
	apiReachable := "skipped"
	apiEndpoint := ""
	if api != nil {
		apiReachable = boolWord(api.Reachable)
		apiEndpoint = api.Endpoint
	}
	proxyConfigured := false
	proxyReachable := false
	proxyURL := ""
	if proxy != nil {
		proxyConfigured = proxy.Configured
		proxyReachable = proxy.Reachable
		proxyURL = proxy.URL
	}
	slog.Info("agent network probe",
		"provider", provider,
		"registry_reachable", registry.Reachable,
		"registry_endpoint", registry.Endpoint,
		"api_reachable", apiReachable,
		"api_endpoint", apiEndpoint,
		"proxy_configured", proxyConfigured,
		"proxy_reachable", proxyReachable,
		"proxy_url", proxyURL,
	)
}

func boolWord(value bool) string {
	if value {
		return "reachable"
	}
	return "unreachable"
}

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

// probeRegistry checks the npm registry fallback chain in the same ranked order
// install uses for the requested package. When none answer, it reports the
// primary registry as the host that could not be reached.
func (s Service) probeRegistry(ctx context.Context, packageName string) NetworkEndpointStatus {
	registries := s.rankedAgentNPMRegistries(ctx, packageName)
	for _, registry := range registries {
		status := s.probeEndpoint(ctx, npmRegistryPackageEndpoint(registry, packageName))
		if status.Reachable {
			status.Endpoint = registry
			return status
		}
	}
	return NetworkEndpointStatus{
		Reachable:  false,
		Endpoint:   s.primaryAgentNPMRegistry(),
		ReasonCode: "network_error",
	}
}

// providerAPIEndpoints lists the actual base URL(s) the provider's CLI talks to
// at run/login time, in priority order. Reachability of ANY of them counts — we
// only check connectivity (DNS/TLS/proxy/region), not which account/mode is in
// use. Empty for providers with no known public endpoint (the check is skipped).
//
// Codex's base URL depends on auth mode (verified against the codex source,
// codex-rs/model-provider-info/src/lib.rs `to_api_provider`): a ChatGPT login
// uses https://chatgpt.com/backend-api/codex, while an API key uses
// https://api.openai.com/v1. Probing only api.openai.com produced a false
// "unreachable" for ChatGPT-login users where that host is blocked but
// chatgpt.com — what codex actually uses — is reachable.
func providerAPIEndpoints(provider string) []string {
	switch provider {
	case agentprovider.Codex:
		return []string{
			"https://chatgpt.com/backend-api/codex",
			"https://api.openai.com/v1",
		}
	case agentprovider.ClaudeCode:
		return []string{"https://api.anthropic.com/v1/messages"}
	case agentprovider.Gemini:
		return []string{"https://generativelanguage.googleapis.com/v1beta/models"}
	default:
		return nil
	}
}

// probeProviderAPI checks the provider's API endpoint(s) — reachable if any one
// answers. Returns nil when the provider has no known endpoint, or when the CLI
// is configured with a custom API key / endpoint (env or on-disk config), since
// the user points at their own base URL/gateway and probing the defaults would
// mislead.
func (s Service) probeProviderAPI(ctx context.Context, provider string) *NetworkEndpointStatus {
	endpoints := providerAPIEndpoints(provider)
	if len(endpoints) == 0 || s.providerUsesCustomConfig(provider) {
		return nil
	}
	var status NetworkEndpointStatus
	for _, endpoint := range endpoints {
		status = s.probeEndpoint(ctx, endpoint)
		if status.Reachable {
			return &status
		}
	}
	return &status
}

// probeProxy detects whether an HTTP proxy is in effect for outbound requests
// and, if so, whether it is reachable. Resolution mirrors the proxy the probe
// HTTP client itself uses (env first, then the macOS system proxy).
func (s Service) probeProxy(ctx context.Context) *NetworkProxyStatus {
	resolve := s.ResolveProxy
	if resolve == nil {
		resolve = runtimecmd.DynamicProxyFunc()
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
