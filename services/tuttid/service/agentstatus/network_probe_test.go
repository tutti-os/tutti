package agentstatus

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

type networkRoundTripFunc func(*http.Request) (*http.Response, error)

func (f networkRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

func networkProbeService(t *testing.T, rt networkRoundTripFunc) Service {
	t.Helper()
	home := t.TempDir()
	return Service{
		Environ:    func() []string { return nil },
		HTTPClient: &http.Client{Transport: rt},
		HomeDir:    func() (string, error) { return home, nil },
	}
}

func TestProbeRegistryReachableReturnsOfficial(t *testing.T) {
	svc := networkProbeService(t, func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			t.Fatalf("expected GET or HEAD, got %s", r.Method)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
	})
	got := svc.probeRegistry(context.Background(), "@openai/codex")
	if !got.Reachable || got.Endpoint != officialNPMRegistry {
		t.Fatalf("probeRegistry() = %#v, want reachable official", got)
	}
}

func TestProbeRegistryReachableEvenOnHTTPError(t *testing.T) {
	// A 405/404 still proves the host was reached — connectivity is fine.
	svc := networkProbeService(t, func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusMethodNotAllowed, Body: http.NoBody}, nil
	})
	if got := svc.probeRegistry(context.Background(), "@openai/codex"); !got.Reachable {
		t.Fatalf("probeRegistry() = %#v, want reachable", got)
	}
}

func TestProbeRegistryUnreachableReportsNetworkError(t *testing.T) {
	svc := networkProbeService(t, func(*http.Request) (*http.Response, error) {
		return nil, errors.New("dial tcp: connect: connection refused")
	})
	got := svc.probeRegistry(context.Background(), "@openai/codex")
	if got.Reachable || got.ReasonCode != "network_error" {
		t.Fatalf("probeRegistry() = %#v, want unreachable network_error", got)
	}
	if got.Endpoint != officialNPMRegistry {
		t.Fatalf("endpoint = %q, want primary registry for context", got.Endpoint)
	}
}

func TestProbeRegistryFallsBackToMirror(t *testing.T) {
	svc := networkProbeService(t, func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Host, "registry.npmjs.org") {
			return nil, errors.New("connection refused")
		}
		return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
	})
	got := svc.probeRegistry(context.Background(), "@openai/codex")
	if !got.Reachable || got.Endpoint == officialNPMRegistry {
		t.Fatalf("probeRegistry() = %#v, want reachable via mirror", got)
	}
}

func TestProbeRegistryReportsRankedMirrorWhenOfficialMetadataIsSlow(t *testing.T) {
	svc := networkProbeService(t, func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodGet && r.URL.Host == "registry.npmjs.org" {
			time.Sleep(75 * time.Millisecond)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
	})

	got := svc.probeRegistry(context.Background(), "@openai/codex")
	if !got.Reachable || got.Endpoint != npmmirrorRegistry {
		t.Fatalf("probeRegistry() = %#v, want ranked mirror %q", got, npmmirrorRegistry)
	}
}

func TestProbeProviderAPIChecksCodexChatGPTEndpointFirst(t *testing.T) {
	var probed string
	svc := networkProbeService(t, func(r *http.Request) (*http.Response, error) {
		probed = r.URL.String()
		return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
	})
	got := svc.probeProviderAPI(context.Background(), agentprovider.Codex)
	if got == nil || !got.Reachable {
		t.Fatalf("probeProviderAPI(codex) = %#v, want reachable", got)
	}
	// ChatGPT-login codex talks to chatgpt.com, so that is probed first.
	if !strings.Contains(probed, "chatgpt.com") {
		t.Fatalf("probed %q, want chatgpt.com first", probed)
	}
}

func TestProbeProviderAPICodexReachableViaOpenAIWhenChatGPTBlocked(t *testing.T) {
	// chatgpt.com blocked but api.openai.com reachable → still reachable (either).
	svc := networkProbeService(t, func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Host, "chatgpt.com") {
			return nil, errors.New("connection refused")
		}
		return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}, nil
	})
	got := svc.probeProviderAPI(context.Background(), agentprovider.Codex)
	if got == nil || !got.Reachable {
		t.Fatalf("probeProviderAPI(codex) = %#v, want reachable via openai fallback", got)
	}
}

func TestProbeProviderAPIUnreachableReportsNetworkError(t *testing.T) {
	svc := networkProbeService(t, func(*http.Request) (*http.Response, error) {
		return nil, errors.New("getaddrinfo ENOTFOUND api.anthropic.com")
	})
	got := svc.probeProviderAPI(context.Background(), agentprovider.ClaudeCode)
	if got == nil || got.Reachable || got.ReasonCode != "network_error" {
		t.Fatalf("probeProviderAPI(claude-code) = %#v, want unreachable network_error", got)
	}
}

func TestProbeProviderAPISkippedForUnknownProvider(t *testing.T) {
	svc := networkProbeService(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("should not probe a provider with no known endpoint")
		return nil, nil
	})
	if got := svc.probeProviderAPI(context.Background(), agentprovider.Nexight); got != nil {
		t.Fatalf("probeProviderAPI(nexight) = %#v, want nil (skipped)", got)
	}
}

func TestProbeProviderAPISkippedWhenCustomAPIKeyConfigured(t *testing.T) {
	svc := networkProbeService(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("should not probe the default endpoint when a custom key is set")
		return nil, nil
	})
	svc.Environ = func() []string { return []string{"OPENAI_API_KEY=sk-test"} }
	if got := svc.probeProviderAPI(context.Background(), agentprovider.Codex); got != nil {
		t.Fatalf("probeProviderAPI(codex w/ key) = %#v, want nil (skipped)", got)
	}
}

func TestProbeProxyNotConfigured(t *testing.T) {
	svc := Service{ResolveProxy: func(*http.Request) (*url.URL, error) { return nil, nil }}
	got := svc.probeProxy(context.Background())
	if got == nil || got.Configured {
		t.Fatalf("probeProxy() = %#v, want configured=false", got)
	}
}

func TestProbeProxyConfiguredAndReachable(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	proxyURL := &url.URL{Scheme: "http", Host: listener.Addr().String()}
	svc := Service{ResolveProxy: func(*http.Request) (*url.URL, error) { return proxyURL, nil }}
	got := svc.probeProxy(context.Background())
	if got == nil || !got.Configured || !got.Reachable {
		t.Fatalf("probeProxy() = %#v, want configured+reachable", got)
	}
	if got.URL != listener.Addr().String() {
		t.Fatalf("proxy URL = %q, want %q", got.URL, listener.Addr().String())
	}
}

func TestProbeProxyConfiguredButUnreachable(t *testing.T) {
	// Bind then immediately close to obtain a port nothing is listening on.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := listener.Addr().String()
	listener.Close()
	proxyURL := &url.URL{Scheme: "http", Host: addr}
	svc := Service{ResolveProxy: func(*http.Request) (*url.URL, error) { return proxyURL, nil }}
	got := svc.probeProxy(context.Background())
	if got == nil || !got.Configured || got.Reachable {
		t.Fatalf("probeProxy() = %#v, want configured but unreachable", got)
	}
	if got.ReasonCode != "network_error" {
		t.Fatalf("reasonCode = %q, want network_error", got.ReasonCode)
	}
}

func TestProxyAddrInfersPortFromScheme(t *testing.T) {
	cases := map[string]string{
		"http://proxy.local":       "proxy.local:80",
		"https://proxy.local":      "proxy.local:443",
		"http://proxy.local:7890":  "proxy.local:7890",
		"https://proxy.local:8443": "proxy.local:8443",
	}
	for raw, want := range cases {
		u, _ := url.Parse(raw)
		if got := proxyAddr(u); got != want {
			t.Fatalf("proxyAddr(%q) = %q, want %q", raw, got, want)
		}
	}
}
