// Package httpx is the single funnel for outbound HTTP from the daemon.
// Every client it hands out resolves proxies per request with the same
// precedence spawned agents get (explicit env > macOS system proxy > direct,
// NO_PROXY and loopback always bypass — see runtimecmd.DynamicProxyFunc).
//
// Direct use of http.DefaultClient / bare http.Client literals is rejected by
// lint (forbidigo + tools/scripts/check-http-client-funnel.mjs) so requests
// cannot silently bypass the proxy policy again.
package httpx

import (
	"net/http"
	"time"

	"github.com/tutti-os/tutti/packages/agentactivity/daemon/runtimecmd"
)

// NewTransport clones the default transport and makes it proxy-aware.
func NewTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = runtimecmd.DynamicProxyFunc()
	return transport
}

// NewClient returns a proxy-aware client with the given total-request timeout.
func NewClient(timeout time.Duration) *http.Client {
	return &http.Client{Transport: NewTransport(), Timeout: timeout}
}

var defaultClient = &http.Client{Transport: NewTransport()}

// Default returns the shared proxy-aware client. It sets no timeout; bound
// requests with a context.
func Default() *http.Client {
	return defaultClient
}
