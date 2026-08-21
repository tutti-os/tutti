package types

import (
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveDefaultsFromEnvUsesSharedGeneratedDefaults(t *testing.T) {
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	t.Setenv("TUTTI_ENV", "development")
	t.Setenv("TUTTI_STATE_DIR", "")
	t.Setenv("TUTTI_LOG_DIR", "")
	t.Setenv("TUTTID_ADDR", "")
	t.Setenv("TUTTID_LISTENER_INFO_PATH", "")

	got := ResolveDefaultsFromEnv()

	assertEqual(t, got.Runtime.Env, "development")
	assertEqual(t, got.State.RootDir, filepath.Join(homeDir, ".tutti-dev"))
	assertEqual(t, got.State.LogsDir, filepath.Join(homeDir, ".tutti-dev", "logs"))
	assertEqual(t, got.State.RunDir, filepath.Join(homeDir, ".tutti-dev", "run"))
	assertEqual(t, got.State.TuttidDBPath, filepath.Join(homeDir, ".tutti-dev", "tuttid.db"))
	assertEqual(t, got.State.TuttidListenerInfoPath, filepath.Join(homeDir, ".tutti-dev", "run", "tuttid.listener.json"))
	assertEqual(t, got.State.TuttidLogPath, filepath.Join(homeDir, ".tutti-dev", "logs", "tuttid.log"))
	assertEqual(t, got.State.DesktopLogPath, filepath.Join(homeDir, ".tutti-dev", "logs", "tutti-desktop.log"))
	assertEqual(t, got.State.TuttidPIDPath, filepath.Join(homeDir, ".tutti-dev", "run", "tuttid.pid"))
	assertEqual(t, got.Transport.TCPAddr, "127.0.0.1:4545")
	assertEqual(t, got.Logging.DefaultLevel, "info")
	assertEqual(t, got.Logging.DefaultOutput, "file")
	assertEqualInt(t, got.Logging.MaxSizeMB, 50)
	assertEqualInt(t, got.Logging.MaxBackups, 10)
	assertEqualInt(t, got.Logging.MaxAgeDays, 14)
	assertEqualInt(t, got.Logging.MaxTotalMB, 300)
}

func TestResolveDefaultsFromEnvAppliesOverrides(t *testing.T) {
	t.Setenv("TUTTI_ENV", "development")
	t.Setenv("TUTTI_STATE_DIR", "/tmp/tutti-state")
	t.Setenv("TUTTI_LOG_DIR", "/tmp/tutti-logs")
	t.Setenv("TUTTID_ADDR", "127.0.0.1:1111")

	got := ResolveDefaultsFromEnv()

	assertEqual(t, got.Runtime.Env, "development")
	assertEqual(t, got.State.RootDir, "/tmp/tutti-state")
	assertEqual(t, got.State.LogsDir, "/tmp/tutti-logs")
	assertEqual(t, got.Transport.TCPAddr, "127.0.0.1:1111")
}

func TestResolveAgentExtensionSourcesUsesGeneratedActivationDefaults(t *testing.T) {
	t.Setenv("TUTTI_AGENT_EXTENSION_GEMINI_ENABLED", "true")

	sources := ResolveAgentExtensionSources()
	byKey := map[string]AgentExtensionSource{}
	for _, source := range sources {
		byKey[source.Key] = source
	}
	gemini, ok := byKey["gemini"]
	if !ok || gemini.Enabled {
		t.Fatalf("gemini source was enabled by removed env override: %#v", sources)
	}
	codebuddy, ok := byKey["codebuddy"]
	if !ok || codebuddy.Enabled {
		t.Fatalf("codebuddy source must stay disabled without override: %#v", sources)
	}
	copilot := agentExtensionSourceByKey(t, sources, "copilot")
	kilo := agentExtensionSourceByKey(t, sources, "kilo")
	qwen := agentExtensionSourceByKey(t, sources, "qwen")
	grok := agentExtensionSourceByKey(t, sources, "grok")
	for _, source := range []AgentExtensionSource{gemini, codebuddy, copilot, kilo, qwen, grok} {
		if source.Enabled {
			t.Fatalf("agent extension source must stay disabled without override: %#v", source)
		}
		if source.SigningKeyID == "" || source.SigningPublicKey == "" {
			t.Fatalf("agent extension trust configuration is incomplete: %#v", source)
		}
	}
	for _, key := range []string{"hermes", "kimi-code"} {
		source := agentExtensionSourceByKey(t, sources, key)
		if !source.Enabled {
			t.Fatalf("stable agent extension source must be enabled: %#v", source)
		}
		if source.SigningKeyID == "" || source.SigningPublicKey == "" {
			t.Fatalf("stable agent extension trust configuration is incomplete: %#v", source)
		}
	}
	wantPinnedVersions := map[string]string{
		"gemini": "2.0.3", "codebuddy": "2.0.5", "copilot": "2.0.3", "kilo": "2.0.3",
		"qwen": "2.0.3", "hermes": "1.0.8", "kimi-code": "1.0.11", "grok": "0.1.2",
	}
	for key, wantVersion := range wantPinnedVersions {
		if got := agentExtensionSourceByKey(t, sources, key).PinnedVersion; got != wantVersion {
			t.Fatalf("agent extension source %q pinned version = %q, want %q", key, got, wantVersion)
		}
	}
}

func TestResolveAgentExtensionSourcesAppliesLocalPackageOnlyInDevelopment(t *testing.T) {
	packageDir := filepath.Join(t.TempDir(), "package")
	helperExecutable := filepath.Join(t.TempDir(), "account-usage")
	t.Setenv("TUTTI_ENV", "development")
	t.Setenv("TUTTI_AGENT_EXTENSION_CODEBUDDY_PACKAGE_DIR", packageDir)
	t.Setenv("TUTTI_AGENT_EXTENSION_CODEBUDDY_ACCOUNT_USAGE_EXECUTABLE", helperExecutable)

	development := agentExtensionSourceByKey(t, ResolveAgentExtensionSources(), "codebuddy")
	if development.Enabled || development.LocalPackageDir != packageDir || development.LocalAccountUsageExecutable != helperExecutable {
		t.Fatalf("development local package override not applied: %#v", development)
	}

	t.Setenv("TUTTI_ENV", "production")
	production := agentExtensionSourceByKey(t, ResolveAgentExtensionSources(), "codebuddy")
	if production.Enabled || production.LocalPackageDir != "" || production.LocalAccountUsageExecutable != "" {
		t.Fatalf("production local package override must be ignored: %#v", production)
	}
}

func TestGrokAgentExtensionSourcePinsApprovedSigningIdentity(t *testing.T) {
	source := agentExtensionSourceByKey(t, ResolveAgentExtensionSources(), "grok")
	if source.Enabled || source.SigningKeyID != "tutti-grok-release-v2" ||
		source.ReleaseIndexURL != "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases/agents/grok/versions.json" {
		t.Fatalf("grok source activation/key identity = %#v", source)
	}
	block, rest := pem.Decode([]byte(source.SigningPublicKey))
	if block == nil || len(rest) != 0 {
		t.Fatal("grok signing public key is not one canonical PEM block")
	}
	if _, err := x509.ParsePKIXPublicKey(block.Bytes); err != nil {
		t.Fatalf("parse grok signing public key: %v", err)
	}
	digest := sha256.Sum256(block.Bytes)
	if got := hex.EncodeToString(digest[:]); got != "1d9c96185b82d9ad0a2102374365a958e6f10d2c9bbdb4a6ab0f7effc503745b" {
		t.Fatalf("grok signing public key SPKI digest = %s", got)
	}
}

func TestKimiCodeAgentExtensionSourceUsesAccountUsageCompatibleIndex(t *testing.T) {
	source := agentExtensionSourceByKey(t, ResolveAgentExtensionSources(), "kimi-code")
	if !source.Enabled || source.SigningKeyID != "tutti-kimi-code-release-v1" ||
		source.ReleaseIndexURL != "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases/agents/kimi-code/account-usage-v1/versions.json" {
		t.Fatalf("kimi-code source activation/key identity = %#v", source)
	}
	if len(source.FallbackReleaseIndexURLs) != 2 ||
		source.FallbackReleaseIndexURLs[0] != "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases/agents/kimi-code/authentication-v1/versions.json" ||
		source.FallbackReleaseIndexURLs[1] != "https://d1x7gb6wqsqmnm.cloudfront.net/tutti-agent-releases/agents/kimi-code/versions.json" {
		t.Fatalf("kimi-code fallback release indexes = %#v", source.FallbackReleaseIndexURLs)
	}
}

func agentExtensionSourceByKey(t *testing.T, sources []AgentExtensionSource, key string) AgentExtensionSource {
	t.Helper()
	for _, source := range sources {
		if source.Key == key {
			return source
		}
	}
	t.Fatalf("agent extension source %q not found", key)
	return AgentExtensionSource{}
}

func TestResolveUVToolArtifactSelectsPlatform(t *testing.T) {
	artifact, ok := ResolveUVToolArtifact("darwin-arm64")
	if !ok {
		t.Fatal("ResolveUVToolArtifact(darwin-arm64) ok = false, want true")
	}
	assertEqual(t, artifact.Version, "0.11.31")
	assertEqual(t, artifact.Platform, "darwin-arm64")
	assertEqual(t, artifact.URL, "https://github.com/astral-sh/uv/releases/download/0.11.31/uv-aarch64-apple-darwin.tar.gz")
	assertEqual(t, artifact.SHA256, "b2b93e82a6786f9c7cb89fd4ca0e859a147b292ae8f6f95784f9742f0efec39e")
	assertEqual(t, artifact.Archive, "tar.gz")
	assertEqual(t, artifact.ArchiveExecutable, "uv-aarch64-apple-darwin/uv")
	if artifact.SizeBytes <= 0 {
		t.Fatalf("artifact size = %d, want > 0", artifact.SizeBytes)
	}
}

func TestResolveUVToolArtifactCoversSupportedPlatforms(t *testing.T) {
	platforms := []string{"darwin-arm64", "darwin-amd64", "linux-amd64", "linux-arm64", "windows-amd64"}
	for _, platform := range platforms {
		artifact, ok := ResolveUVToolArtifact(platform)
		if !ok {
			t.Fatalf("ResolveUVToolArtifact(%q) ok = false, want true", platform)
		}
		if !strings.HasPrefix(artifact.URL, "https://") {
			t.Fatalf("platform %q url = %q, want https", platform, artifact.URL)
		}
		if len(artifact.SHA256) != 64 {
			t.Fatalf("platform %q sha256 length = %d, want 64", platform, len(artifact.SHA256))
		}
		if artifact.SizeBytes <= 0 {
			t.Fatalf("platform %q size = %d, want > 0", platform, artifact.SizeBytes)
		}
		if artifact.Archive != "tar.gz" && artifact.Archive != "zip" {
			t.Fatalf("platform %q archive = %q, want tar.gz or zip", platform, artifact.Archive)
		}
		if artifact.ArchiveExecutable == "" {
			t.Fatalf("platform %q archive executable is empty", platform)
		}
	}
}

func TestResolveUVToolArtifactRejectsUnknownPlatform(t *testing.T) {
	for _, platform := range []string{"", "plan9-amd64", "darwin"} {
		if artifact, ok := ResolveUVToolArtifact(platform); ok {
			t.Fatalf("ResolveUVToolArtifact(%q) = %#v, want ok=false", platform, artifact)
		}
	}
}

func TestDesktopLoginCallbackURLUsesEnvironmentScheme(t *testing.T) {
	t.Setenv("TUTTI_ENV", "development")
	assertEqual(t, DesktopLoginCallbackURL(), "tutti-dev://login/callback")

	t.Setenv("TUTTI_ENV", "production")
	assertEqual(t, DesktopLoginCallbackURL(), "tutti://login/callback")
}

func TestResolveAnalyticsConfigUsesGeneratedDefaults(t *testing.T) {
	t.Setenv("TUTTI_ENV", "")
	t.Setenv("TUTTI_ANALYTICS_DISABLED", "")
	t.Setenv("TUTTI_ANALYTICS_APP_ID", "")
	t.Setenv("TUTTI_ANALYTICS_APP_KEY", "")
	t.Setenv("TUTTI_ANALYTICS_CHANNEL_DOMAIN", "")
	t.Setenv("TUTTI_APP_VERSION", "")
	t.Setenv("TUTTI_ANALYTICS_APP_VERSION", "")

	got := ResolveAnalyticsConfig()

	if got.Disabled {
		t.Fatal("analytics disabled = true, want false")
	}
	assertEqualInt(t, got.AppID, 20004134)
	assertEqual(t, got.AppKey, "984646081c1dc9dbe502e9c5e17711fbf9d9fdb85047eb7808db4776c34c0af0")
	assertEqual(t, got.Channel, "sg")
	assertEqual(t, got.ChannelDomain, "https://gator.uba.ap-southeast-1.volces.com")
	assertEqual(t, got.AppVersion, "0.0.0")
}

func TestResolveAnalyticsConfigEnablesDebugPipelineInDevelopment(t *testing.T) {
	t.Setenv("TUTTI_ENV", "development")
	t.Setenv("TUTTI_ANALYTICS_DISABLED", "")
	t.Setenv("TUTTI_ANALYTICS_APP_ID", "")
	t.Setenv("TUTTI_ANALYTICS_APP_KEY", "")
	t.Setenv("TUTTI_ANALYTICS_CHANNEL_DOMAIN", "")
	t.Setenv("TUTTI_APP_VERSION", "")
	t.Setenv("TUTTI_ANALYTICS_APP_VERSION", "")

	got := ResolveAnalyticsConfig()

	if got.Disabled {
		t.Fatal("analytics disabled = true, want false so development can publish local debug events")
	}
	if !got.Debug {
		t.Fatal("analytics debug = false, want true in development")
	}
}

func TestResolveAnalyticsConfigAppliesOverrides(t *testing.T) {
	t.Setenv("TUTTI_ENV", "")
	t.Setenv("TUTTI_ANALYTICS_DISABLED", "true")
	t.Setenv("TUTTI_ANALYTICS_APP_ID", "123")
	t.Setenv("TUTTI_ANALYTICS_APP_KEY", "dev-key")
	t.Setenv("TUTTI_ANALYTICS_CHANNEL_DOMAIN", "https://example.test")
	t.Setenv("TUTTI_APP_VERSION", "")
	t.Setenv("TUTTI_ANALYTICS_APP_VERSION", "1.2.3")

	got := ResolveAnalyticsConfig()

	if !got.Disabled {
		t.Fatal("analytics disabled = false, want true")
	}
	assertEqualInt(t, got.AppID, 123)
	assertEqual(t, got.AppKey, "dev-key")
	assertEqual(t, got.ChannelDomain, "https://example.test")
	assertEqual(t, got.AppVersion, "1.2.3")
}

func TestResolveAnalyticsConfigEnablesDebugForDevelopmentOnly(t *testing.T) {
	cases := []struct {
		name     string
		tuttiEnv string
		want     bool
	}{
		{name: "development", tuttiEnv: "development", want: true},
		{name: "production", tuttiEnv: "production", want: false},
		{name: "unset env", tuttiEnv: "", want: false},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TUTTI_ENV", tt.tuttiEnv)
			t.Setenv("TUTTI_ANALYTICS_DISABLED", "")
			t.Setenv("TUTTI_ANALYTICS_APP_ID", "")
			t.Setenv("TUTTI_ANALYTICS_APP_KEY", "")
			t.Setenv("TUTTI_ANALYTICS_CHANNEL_DOMAIN", "")
			t.Setenv("TUTTI_APP_VERSION", "")
			t.Setenv("TUTTI_ANALYTICS_APP_VERSION", "")

			got := ResolveAnalyticsConfig()

			assertEqualBool(t, got.Debug, tt.want)
		})
	}
}

func TestResolveAnalyticsConfigParsesDisabledOverride(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "empty", value: "", want: false},
		{name: "true", value: "true", want: true},
		{name: "uppercase true", value: "TRUE", want: true},
		{name: "one", value: "1", want: true},
		{name: "yes", value: "yes", want: true},
		{name: "false", value: "false", want: false},
		{name: "uppercase false", value: "FALSE", want: false},
		{name: "zero", value: "0", want: false},
		{name: "no", value: "no", want: false},
		{name: "invalid", value: "treu", want: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TUTTI_ANALYTICS_DISABLED", tt.value)
			t.Setenv("TUTTI_ANALYTICS_APP_ID", "")
			t.Setenv("TUTTI_ANALYTICS_APP_KEY", "")
			t.Setenv("TUTTI_ANALYTICS_CHANNEL_DOMAIN", "")
			t.Setenv("TUTTI_APP_VERSION", "")
			t.Setenv("TUTTI_ANALYTICS_APP_VERSION", "")

			got := ResolveAnalyticsConfig()

			assertEqualBool(t, got.Disabled, tt.want)
		})
	}
}

func TestResolveAnalyticsConfigParsesAppIDOverride(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  int
	}{
		{name: "empty", value: "", want: 20004134},
		{name: "positive integer", value: "123", want: 123},
		{name: "zero", value: "0", want: 0},
		{name: "negative", value: "-1", want: 0},
		{name: "non numeric", value: "abc", want: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TUTTI_ANALYTICS_DISABLED", "")
			t.Setenv("TUTTI_ANALYTICS_APP_ID", tt.value)
			t.Setenv("TUTTI_ANALYTICS_APP_KEY", "")
			t.Setenv("TUTTI_ANALYTICS_CHANNEL_DOMAIN", "")
			t.Setenv("TUTTI_APP_VERSION", "")
			t.Setenv("TUTTI_ANALYTICS_APP_VERSION", "")

			got := ResolveAnalyticsConfig()

			assertEqualInt(t, got.AppID, tt.want)
		})
	}
}

func TestResolveAnalyticsConfigResolvesAppVersionOverride(t *testing.T) {
	tests := []struct {
		name                     string
		appVersion               string
		analyticsSpecificVersion string
		want                     string
	}{
		{name: "empty", appVersion: "", analyticsSpecificVersion: "", want: "0.0.0"},
		{name: "shared app version", appVersion: "1.2.3", analyticsSpecificVersion: "", want: "1.2.3"},
		{name: "analytics specific version takes precedence", appVersion: "1.2.3", analyticsSpecificVersion: "2.3.4", want: "2.3.4"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv("TUTTI_ANALYTICS_DISABLED", "")
			t.Setenv("TUTTI_ANALYTICS_APP_ID", "")
			t.Setenv("TUTTI_ANALYTICS_APP_KEY", "")
			t.Setenv("TUTTI_ANALYTICS_CHANNEL_DOMAIN", "")
			t.Setenv("TUTTI_APP_VERSION", tt.appVersion)
			t.Setenv("TUTTI_ANALYTICS_APP_VERSION", tt.analyticsSpecificVersion)

			got := ResolveAnalyticsConfig()

			assertEqual(t, got.AppVersion, tt.want)
		})
	}
}

func TestResolveAppVersionIgnoresAnalyticsSpecificOverride(t *testing.T) {
	t.Setenv("TUTTI_APP_VERSION", "1.2.3")
	t.Setenv("TUTTI_ANALYTICS_APP_VERSION", "9.9.9")

	assertEqual(t, ResolveAppVersion(), "1.2.3")
}

func assertEqual(t *testing.T, got string, want string) {
	t.Helper()
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func assertEqualInt(t *testing.T, got int, want int) {
	t.Helper()
	if got != want {
		t.Fatalf("got %d, want %d", got, want)
	}
}

func assertEqualBool(t *testing.T, got bool, want bool) {
	t.Helper()
	if got != want {
		t.Fatalf("got %t, want %t", got, want)
	}
}
