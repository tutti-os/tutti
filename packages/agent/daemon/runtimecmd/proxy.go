package runtimecmd

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// System proxy injection.
//
// The standalone ACP agents we spawn (e.g. `claude`) only honor the
// HTTP(S)_PROXY environment variables — they do NOT read the macOS system proxy.
// The Claude desktop app works around this by resolving the OS proxy via
// Electron's session.resolveProxy() (Chromium/SystemConfiguration) and injecting
// HTTPS_PROXY/HTTP_PROXY into the spawned process. Without it, a child agent
// connects directly and, from a restricted region, gets `403 Request not
// allowed` from the upstream API while the app keeps working.
//
// We mirror that behavior here by reading the same SystemConfiguration data via
// `scutil --proxy` and injecting equivalent env vars. To stay faithful to the
// app we: skip SOCKS entries (downstream HTTP agents don't speak SOCKS), use the
// same default NO_PROXY, and never override a proxy the user/session already set.

// noProxyDefault matches the value the Claude desktop app injects.
const noProxyDefault = "localhost,127.0.0.1,::1,.local"

// injectSystemProxyEnv appends HTTPS_PROXY/HTTP_PROXY/NO_PROXY derived from the
// macOS system proxy, but only for keys not already present (case-insensitive)
// in env, so explicit user/session settings always win.
func (r Resolver) injectSystemProxyEnv(env []string) []string {
	proxyEnv := r.systemProxyEnv()
	if len(proxyEnv) == 0 {
		return env
	}
	for _, key := range []string{"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"} {
		value, ok := proxyEnv[key]
		if !ok || strings.TrimSpace(value) == "" {
			continue
		}
		if _, exists := envValueFrom(env, key); exists {
			continue
		}
		env = append(env, key+"="+value)
	}
	return env
}

// InjectSystemProxyEnv appends the macOS system proxy variables
// (HTTPS_PROXY/HTTP_PROXY/NO_PROXY) to env for any key not already present,
// reading the same SystemConfiguration source as Resolver.Env(). It exists so
// the spawn paths that build their own environment instead of going through
// Resolver.Env() — managed-runtime installs, agent logins, workspace terminals —
// get identical proxy treatment. No-op on non-macOS or when no system proxy is
// configured; never overrides a user/session-set value.
func InjectSystemProxyEnv(env []string) []string {
	return Resolver{}.injectSystemProxyEnv(env)
}

// SystemProxyURL returns the macOS system proxy (HTTPS preferred, then HTTP) as
// a URL, if one is configured. In-process HTTP clients (e.g. installer
// downloads) cannot inherit a spawned child's injected env, so they consult this
// directly. Returns (nil, false) on non-macOS or when no proxy is set.
func SystemProxyURL() (*url.URL, bool) {
	return systemProxyURLFrom(Resolver{}.systemProxyEnv())
}

// systemProxyURLFrom parses the HTTPS (preferred) or HTTP proxy URL out of a
// proxy env map. Split out so the URL-selection logic is testable without
// invoking scutil.
func systemProxyURLFrom(proxyEnv map[string]string) (*url.URL, bool) {
	raw := strings.TrimSpace(proxyEnv["HTTPS_PROXY"])
	if raw == "" {
		raw = strings.TrimSpace(proxyEnv["HTTP_PROXY"])
	}
	if raw == "" {
		return nil, false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed == nil {
		return nil, false
	}
	return parsed, true
}

// HTTPProxyFunc returns an http.Transport.Proxy function that prefers an
// explicit proxy from the process environment (honoring NO_PROXY) and falls back
// to the macOS system proxy. It mirrors InjectSystemProxyEnv for in-process
// downloads so installs from a restricted region don't connect directly and hit
// `403 Request not allowed`. The system-proxy fallback is resolved once, when
// the function is built.
func HTTPProxyFunc() func(*http.Request) (*url.URL, error) {
	systemURL, hasSystem := SystemProxyURL()
	return httpProxyFunc(http.ProxyFromEnvironment, systemURL, hasSystem)
}

// httpProxyFunc builds the proxy selector from its dependencies so the
// env-first / system-fallback precedence is testable without touching the real
// process environment or scutil.
func httpProxyFunc(
	envProxy func(*http.Request) (*url.URL, error),
	systemURL *url.URL,
	hasSystem bool,
) func(*http.Request) (*url.URL, error) {
	return func(req *http.Request) (*url.URL, error) {
		envURL, err := envProxy(req)
		if err != nil || envURL != nil {
			return envURL, err
		}
		if hasSystem {
			return systemURL, nil
		}
		return nil, nil
	}
}

func (r Resolver) systemProxyEnv() map[string]string {
	output, ok := r.scutilProxy()
	if !ok {
		return nil
	}
	return parseScutilProxy(output)
}

func (r Resolver) scutilProxy() (string, bool) {
	if r.ScutilProxy != nil {
		return r.ScutilProxy()
	}
	return runScutilProxy()
}

// runScutilProxy reads the macOS system proxy configuration. It is a no-op on
// non-macOS platforms, where proxies are conventionally driven by env vars.
func runScutilProxy() (string, bool) {
	if runtime.GOOS != "darwin" {
		return "", false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "scutil", "--proxy").Output()
	if err != nil {
		return "", false
	}
	return string(out), true
}

// parseScutilProxy turns `scutil --proxy` output into proxy env vars.
//
// Example input:
//
//	<dictionary> {
//	  HTTPSEnable : 1
//	  HTTPSProxy : 127.0.0.1
//	  HTTPSPort : 7890
//	  ...
//	}
//
// SOCKS entries are intentionally ignored, and PAC (ProxyAutoConfig) is not
// resolved — scutil only exposes the PAC URL, not the per-URL result, so we
// leave those to the user's explicit env. Returns nil when no usable proxy is
// configured (direct connection).
func parseScutilProxy(output string) map[string]string {
	fields := map[string]string{}
	for _, line := range strings.Split(output, "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fields[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}

	proxyURL := func(enableKey, hostKey, portKey string) string {
		if fields[enableKey] != "1" {
			return ""
		}
		host := fields[hostKey]
		port := fields[portKey]
		if host == "" || port == "" {
			return ""
		}
		return "http://" + net.JoinHostPort(host, port)
	}

	// Prefer the HTTPS entry (the upstream API is HTTPS); fall back to HTTP.
	// Both env vars point at the same proxy, mirroring the Claude app.
	url := proxyURL("HTTPSEnable", "HTTPSProxy", "HTTPSPort")
	if url == "" {
		url = proxyURL("HTTPEnable", "HTTPProxy", "HTTPPort")
	}
	if url == "" {
		return nil
	}

	return map[string]string{
		"HTTPS_PROXY": url,
		"HTTP_PROXY":  url,
		"NO_PROXY":    noProxyDefault,
	}
}
