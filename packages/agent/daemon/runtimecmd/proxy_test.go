package runtimecmd

import (
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/http/httpproxy"
)

// Real-world `scutil --proxy` output with Clash Verge system proxy enabled
// (HTTP/HTTPS/SOCKS all pointing at 127.0.0.1:7890).
const scutilProxyEnabled = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}`

const scutilProxyDisabled = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
  }
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}`

func TestParseScutilProxyEnabled(t *testing.T) {
	got := parseScutilProxy(scutilProxyEnabled)
	want := map[string]string{
		"HTTPS_PROXY": "http://127.0.0.1:7890",
		"HTTP_PROXY":  "http://127.0.0.1:7890",
		"NO_PROXY":    noProxyDefault,
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("parseScutilProxy()[%q] = %q, want %q", k, got[k], v)
		}
	}
}

func TestParseScutilProxyDisabledReturnsNil(t *testing.T) {
	if got := parseScutilProxy(scutilProxyDisabled); got != nil {
		t.Fatalf("parseScutilProxy() = %v, want nil", got)
	}
}

func TestParseScutilProxyHTTPOnly(t *testing.T) {
	out := `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 10.0.0.2
  HTTPPort : 3128
  HTTPSEnable : 0
  SOCKSEnable : 0
}`
	got := parseScutilProxy(out)
	if got["HTTP_PROXY"] != "http://10.0.0.2:3128" || got["HTTPS_PROXY"] != "http://10.0.0.2:3128" {
		t.Fatalf("parseScutilProxy() = %v, want HTTP(S)_PROXY=http://10.0.0.2:3128", got)
	}
}

func TestParseScutilProxySOCKSOnlyIgnored(t *testing.T) {
	out := `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 7890
}`
	if got := parseScutilProxy(out); got != nil {
		t.Fatalf("parseScutilProxy() with SOCKS only = %v, want nil (SOCKS skipped)", got)
	}
}

func TestEnvInjectsSystemProxy(t *testing.T) {
	resolver := Resolver{
		Environ:     func() []string { return []string{"PATH=/usr/bin:/bin"} },
		HomeDir:     func() (string, error) { return t.TempDir(), nil },
		ScutilProxy: func() (string, bool) { return scutilProxyEnabled, true },
	}
	env := resolver.Env(nil)
	if got := envValue(env, "HTTPS_PROXY"); got != "http://127.0.0.1:7890" {
		t.Fatalf("HTTPS_PROXY = %q, want http://127.0.0.1:7890", got)
	}
	if got := envValue(env, "HTTP_PROXY"); got != "http://127.0.0.1:7890" {
		t.Fatalf("HTTP_PROXY = %q, want http://127.0.0.1:7890", got)
	}
	if got := envValue(env, "NO_PROXY"); got != noProxyDefault {
		t.Fatalf("NO_PROXY = %q, want %q", got, noProxyDefault)
	}
}

func TestEnvDoesNotOverrideExplicitProxy(t *testing.T) {
	resolver := Resolver{
		// User already exported a (lowercase) proxy — must be preserved.
		Environ: func() []string {
			return []string{"PATH=/usr/bin:/bin", "https_proxy=http://user-set:1080"}
		},
		HomeDir:     func() (string, error) { return t.TempDir(), nil },
		ScutilProxy: func() (string, bool) { return scutilProxyEnabled, true },
	}
	env := resolver.Env(nil)
	if got := envValue(env, "https_proxy"); got != "http://user-set:1080" {
		t.Fatalf("https_proxy = %q, want it preserved as http://user-set:1080", got)
	}
	// And we must not have appended a conflicting upper-case HTTPS_PROXY.
	count := 0
	for _, item := range env {
		if k, _, _ := strings.Cut(item, "="); strings.EqualFold(k, "HTTPS_PROXY") {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("found %d HTTPS_PROXY entries, want exactly 1 (no override)", count)
	}
}

func TestEnvNoProxyWhenScutilUnavailable(t *testing.T) {
	resolver := Resolver{
		Environ:     func() []string { return []string{"PATH=/usr/bin:/bin"} },
		HomeDir:     func() (string, error) { return t.TempDir(), nil },
		ScutilProxy: func() (string, bool) { return "", false },
	}
	env := resolver.Env(nil)
	if got := envValue(env, "HTTPS_PROXY"); got != "" {
		t.Fatalf("HTTPS_PROXY = %q, want empty when scutil unavailable", got)
	}
}

func proxyFor(t *testing.T, cfg *httpproxy.Config, rawURL string) *url.URL {
	t.Helper()
	target, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("url.Parse(%q): %v", rawURL, err)
	}
	proxy, err := cfg.ProxyFunc()(target)
	if err != nil {
		t.Fatalf("ProxyFunc(%q): %v", rawURL, err)
	}
	return proxy
}

func TestMergeSystemProxyEnvWins(t *testing.T) {
	cfg := &httpproxy.Config{HTTPSProxy: "http://env-proxy:8080"}
	mergeSystemProxy(cfg, map[string]string{
		"HTTPS_PROXY": "http://system-proxy:7890",
		"HTTP_PROXY":  "http://system-proxy:7890",
		"NO_PROXY":    noProxyDefault,
	})
	if cfg.HTTPSProxy != "http://env-proxy:8080" {
		t.Fatalf("HTTPSProxy = %q, want env value preserved", cfg.HTTPSProxy)
	}
	if cfg.HTTPProxy != "http://system-proxy:7890" {
		t.Fatalf("HTTPProxy = %q, want system value filling the blank", cfg.HTTPProxy)
	}
	if got := proxyFor(t, cfg, "https://api.anthropic.com/v1"); got == nil || got.Host != "env-proxy:8080" {
		t.Fatalf("proxy = %v, want env proxy env-proxy:8080", got)
	}
}

func TestMergeSystemProxyFallsBackToSystem(t *testing.T) {
	cfg := &httpproxy.Config{}
	mergeSystemProxy(cfg, map[string]string{
		"HTTPS_PROXY": "http://system-proxy:7890",
		"HTTP_PROXY":  "http://system-proxy:7890",
		"NO_PROXY":    noProxyDefault,
	})
	if got := proxyFor(t, cfg, "https://api.anthropic.com/v1"); got == nil || got.Host != "system-proxy:7890" {
		t.Fatalf("proxy = %v, want system proxy when env has none", got)
	}
}

func TestMergeSystemProxyDirectWhenNoneConfigured(t *testing.T) {
	cfg := &httpproxy.Config{}
	mergeSystemProxy(cfg, nil)
	if got := proxyFor(t, cfg, "https://api.anthropic.com/v1"); got != nil {
		t.Fatalf("proxy = %v, want nil (direct) when nothing configured", got)
	}
}

func TestMergeSystemProxyBypassesLoopbackAndNoProxy(t *testing.T) {
	cfg := &httpproxy.Config{}
	mergeSystemProxy(cfg, map[string]string{
		"HTTPS_PROXY": "http://system-proxy:7890",
		"HTTP_PROXY":  "http://system-proxy:7890",
		"NO_PROXY":    noProxyDefault,
	})
	for _, target := range []string{
		"http://127.0.0.1:4545/v1/health",
		"http://localhost:4545/v1/health",
		"https://printer.local/status",
	} {
		if got := proxyFor(t, cfg, target); got != nil {
			t.Fatalf("proxy for %q = %v, want nil (local bypass)", target, got)
		}
	}
	if got := proxyFor(t, cfg, "https://api.anthropic.com/v1"); got == nil {
		t.Fatalf("proxy for external target = nil, want system proxy")
	}
}

func TestMergeSystemProxyDefaultsNoProxyForEnvOnlyProxy(t *testing.T) {
	// Env sets a proxy but no NO_PROXY, and no system proxy exists: the
	// default exclusions still apply so .local names never hit the proxy.
	cfg := &httpproxy.Config{HTTPSProxy: "http://env-proxy:8080"}
	mergeSystemProxy(cfg, nil)
	if cfg.NoProxy != noProxyDefault {
		t.Fatalf("NoProxy = %q, want default %q", cfg.NoProxy, noProxyDefault)
	}
}

func TestProxyAutodetectDisabledSkipsInjection(t *testing.T) {
	t.Setenv(disableProxyAutodetectEnvKey, "1")
	resolver := Resolver{
		Environ:     func() []string { return []string{"PATH=/usr/bin:/bin"} },
		HomeDir:     func() (string, error) { return t.TempDir(), nil },
		ScutilProxy: func() (string, bool) { return scutilProxyEnabled, true },
	}
	env := resolver.Env(nil)
	if got := envValue(env, "HTTPS_PROXY"); got != "" {
		t.Fatalf("HTTPS_PROXY = %q, want empty when autodetect disabled", got)
	}
}

func TestProxyAutodetectDisabledKeepsEnvProxy(t *testing.T) {
	t.Setenv(disableProxyAutodetectEnvKey, "true")
	t.Setenv("HTTPS_PROXY", "http://env-proxy:8080")
	fn := DynamicProxyFunc()
	request, err := http.NewRequest(http.MethodGet, "https://api.anthropic.com/v1", nil)
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	got, err := fn(request)
	if err != nil {
		t.Fatalf("proxy func err = %v", err)
	}
	if got == nil || got.Host != "env-proxy:8080" {
		t.Fatalf("proxy = %v, want explicit env proxy to keep working", got)
	}
}

func TestSystemProxyEnvCachesScutil(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("scutil cache path is darwin-only")
	}
	systemProxyCache.Lock()
	systemProxyCache.env = map[string]string{"HTTPS_PROXY": "http://cached-proxy:7890"}
	systemProxyCache.expiresAt = time.Now().Add(time.Minute)
	systemProxyCache.Unlock()
	t.Cleanup(func() {
		systemProxyCache.Lock()
		systemProxyCache.env = nil
		systemProxyCache.expiresAt = time.Time{}
		systemProxyCache.Unlock()
	})
	got := Resolver{}.systemProxyEnv()
	if got["HTTPS_PROXY"] != "http://cached-proxy:7890" {
		t.Fatalf("systemProxyEnv() = %v, want cached value within TTL", got)
	}
}
