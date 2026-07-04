package runtimecmd

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/http/httpproxy"
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
//
// Effective precedence, everywhere (spawned agents and in-process clients):
//
//	session-explicit env > process env (incl. the user's shell env, when the
//	desktop forwards it) > macOS system proxy > direct
//
// Out of scope, deliberately: SOCKS proxies and PAC resolution (scutil only
// exposes the PAC URL; the desktop's Chromium stack handles PAC natively for
// its own requests), and Windows/Linux system-proxy detection (those platforms
// conventionally drive proxies via env vars, which the precedence above already
// honors). Setting TUTTI_DISABLE_PROXY_AUTODETECT=1 disables the system-proxy
// detection and injection entirely; explicit env proxies keep working.

// noProxyDefault matches the value the Claude desktop app injects.
const noProxyDefault = "localhost,127.0.0.1,::1,.local"

// disableProxyAutodetectEnvKey is the escape hatch for machines where the
// detected system proxy is broken but direct connections work.
const disableProxyAutodetectEnvKey = "TUTTI_DISABLE_PROXY_AUTODETECT"

func proxyAutodetectDisabled() bool {
	value := strings.TrimSpace(os.Getenv(disableProxyAutodetectEnvKey))
	return value == "1" || strings.EqualFold(value, "true")
}

// injectSystemProxyEnv appends HTTPS_PROXY/HTTP_PROXY/NO_PROXY derived from the
// macOS system proxy, but only for keys not already present (case-insensitive)
// in env, so explicit user/session settings always win.
func (r Resolver) injectSystemProxyEnv(env []string) []string {
	if proxyAutodetectDisabled() {
		return env
	}
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

// DynamicProxyFunc returns an http.Transport.Proxy function that resolves the
// proxy per request: explicit proxies from the process environment win, the
// macOS system proxy fills in the blanks, and NO_PROXY (from env, the system
// exceptions, or noProxyDefault) plus loopback targets always bypass. It is the
// in-process counterpart of InjectSystemProxyEnv, so daemon HTTP clients and
// spawned agents make the same routing decision. The system proxy is re-read
// (through a short-lived cache) on every call, so toggling the proxy panel
// takes effect without restarting the daemon.
func DynamicProxyFunc() func(*http.Request) (*url.URL, error) {
	return func(req *http.Request) (*url.URL, error) {
		cfg := httpproxy.FromEnvironment()
		if !proxyAutodetectDisabled() {
			mergeSystemProxy(cfg, Resolver{}.systemProxyEnv())
		}
		return cfg.ProxyFunc()(req.URL)
	}
}

// EffectiveProxySummary reports which source currently supplies the outbound
// proxy — "env" (explicit environment variables), "system" (macOS system
// proxy), or "none" — plus the proxy address as host:port with any credentials
// stripped. Startup/diagnostic logging only; it answers "did requests on this
// machine go through a proxy" without another capture round-trip.
func EffectiveProxySummary() (source string, host string) {
	fromEnv := httpproxy.FromEnvironment()
	if raw := firstNonEmptyString(fromEnv.HTTPSProxy, fromEnv.HTTPProxy); raw != "" {
		return "env", proxyHostForLog(raw)
	}
	if proxyAutodetectDisabled() {
		return "none", ""
	}
	sys := Resolver{}.systemProxyEnv()
	if raw := firstNonEmptyString(sys["HTTPS_PROXY"], sys["HTTP_PROXY"]); raw != "" {
		return "system", proxyHostForLog(raw)
	}
	return "none", ""
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// proxyHostForLog reduces a proxy URL to host:port, never exposing userinfo.
func proxyHostForLog(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil || parsed == nil || parsed.Host == "" {
		// Scheme-less values ("host:port") parse without a Host; retry with an
		// explicit scheme rather than logging the raw (possibly credentialed)
		// string.
		parsed, err = url.Parse("http://" + raw)
		if err != nil || parsed == nil {
			return ""
		}
	}
	return parsed.Host
}

// SystemProxyEnv exposes the (cached) macOS system proxy as env-style keys
// (HTTPS_PROXY/HTTP_PROXY/NO_PROXY) for observability call sites that want to
// log the effective proxy source. Returns nil when autodetect is disabled or no
// system proxy is configured.
func SystemProxyEnv() map[string]string {
	if proxyAutodetectDisabled() {
		return nil
	}
	return Resolver{}.systemProxyEnv()
}

// mergeSystemProxy fills empty fields of an env-derived proxy config with the
// system proxy values, preserving env-first precedence. When any proxy ends up
// configured without a NO_PROXY, noProxyDefault applies so local services are
// never routed through the proxy (httpproxy additionally hard-bypasses
// loopback hosts).
func mergeSystemProxy(cfg *httpproxy.Config, systemEnv map[string]string) {
	if cfg.HTTPSProxy == "" {
		cfg.HTTPSProxy = systemEnv["HTTPS_PROXY"]
	}
	if cfg.HTTPProxy == "" {
		cfg.HTTPProxy = systemEnv["HTTP_PROXY"]
	}
	if cfg.NoProxy == "" {
		cfg.NoProxy = systemEnv["NO_PROXY"]
	}
	if cfg.NoProxy == "" && (cfg.HTTPSProxy != "" || cfg.HTTPProxy != "") {
		cfg.NoProxy = noProxyDefault
	}
}

// systemProxyCache memoizes the parsed `scutil --proxy` output so hot paths
// (per-spawn env injection, per-request proxy resolution) don't fork a scutil
// process each time, while still noticing proxy-panel toggles within the TTL.
var systemProxyCache = struct {
	sync.Mutex
	env       map[string]string
	expiresAt time.Time
}{}

const systemProxyCacheTTL = 60 * time.Second

func (r Resolver) systemProxyEnv() map[string]string {
	if r.ScutilProxy != nil {
		// Injected (test) source: bypass the cache so cases stay independent.
		output, ok := r.ScutilProxy()
		if !ok {
			return nil
		}
		return parseScutilProxy(output)
	}
	systemProxyCache.Lock()
	defer systemProxyCache.Unlock()
	if time.Now().Before(systemProxyCache.expiresAt) {
		return systemProxyCache.env
	}
	var env map[string]string
	if output, ok := runScutilProxy(); ok {
		env = parseScutilProxy(output)
	}
	systemProxyCache.env = env
	systemProxyCache.expiresAt = time.Now().Add(systemProxyCacheTTL)
	return env
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
