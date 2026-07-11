package agentruntime

import (
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestMigratedCodexDescriptorBuildsDefaultAdapter(t *testing.T) {
	descriptor, ok := providerregistry.Find(ProviderCodex)
	if !ok {
		t.Fatal("codex descriptor missing")
	}
	descriptor.Runtime.ClientInfoName = "descriptor-client"
	descriptor.Runtime.AuthRequiredMessage = "descriptor auth required"
	adapter := newAdapterFromProviderDescriptor(
		descriptor,
		newScriptedAppServerTransport(),
		LegacyHostMetadata(),
		nil,
	)
	if adapter == nil {
		t.Fatal("adapter = nil")
	}
	if adapter.Provider() != ProviderCodex {
		t.Fatalf("adapter.Provider() = %q", adapter.Provider())
	}
	appServerAdapter, ok := adapter.(*CodexAppServerAdapter)
	if !ok {
		t.Fatalf("adapter type = %T", adapter)
	}
	serverInfo := appServerAdapter.appServerInfo(nil)
	if serverInfo["name"] != descriptor.Runtime.Name || serverInfo["title"] != descriptor.Identity.DisplayName {
		t.Fatalf("server info = %#v, want descriptor runtime/display identity", serverInfo)
	}
	if appServerAdapter.config.clientInfoName != descriptor.Runtime.ClientInfoName ||
		appServerAdapter.config.authRequiredMessage != descriptor.Runtime.AuthRequiredMessage {
		t.Fatalf("adapter config = %#v, want descriptor runtime identity/auth", appServerAdapter.config)
	}
}

func TestMigratedClaudeCodeDescriptorBuildsSDKAdapter(t *testing.T) {
	descriptor, ok := providerregistry.Find(ProviderClaudeCode)
	if !ok {
		t.Fatal("claude-code descriptor missing")
	}
	adapter := newAdapterFromProviderDescriptor(descriptor, nil, HostMetadata{}, nil)
	if _, ok := adapter.(*ClaudeCodeSDKAdapter); !ok {
		t.Fatalf("adapter = %T, want *ClaudeCodeSDKAdapter", adapter)
	}
	if adapter.Provider() != ProviderClaudeCode {
		t.Fatalf("adapter.Provider() = %q", adapter.Provider())
	}
}

func TestMigratedClaudeCodeDescriptorOwnsPermissionModes(t *testing.T) {
	if got := defaultPermissionModeIDForProvider(ProviderClaudeCode); got != "default" {
		t.Fatalf("default permission mode = %q", got)
	}
	for _, mode := range []string{"default", "acceptEdits", "dontAsk", "bypassPermissions"} {
		if !permissionModeIDAllowedForProvider(ProviderClaudeCode, mode) {
			t.Fatalf("permission mode %q rejected", mode)
		}
	}
	if permissionModeIDAllowedForProvider(ProviderClaudeCode, "auto") {
		t.Fatal("legacy permission mode auto accepted")
	}
}

func TestSharedAppServerAdapterKeepsTuttiAgentIdentity(t *testing.T) {
	adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(nil, HostMetadata{})
	serverInfo := adapter.appServerInfo(nil)
	if serverInfo["name"] != "tutti-agent-app-server" || serverInfo["title"] != "Tutti Agent" {
		t.Fatalf("server info = %#v, want Tutti Agent identity", serverInfo)
	}
}

func TestMigratedCodexDescriptorOwnsPermissionModes(t *testing.T) {
	if got := defaultPermissionModeIDForProvider(ProviderCodex); got != "auto" {
		t.Fatalf("default permission mode = %q", got)
	}
	for _, mode := range []string{"read-only", "auto", "full-access"} {
		if !permissionModeIDAllowedForProvider(ProviderCodex, mode) {
			t.Fatalf("permission mode %q rejected", mode)
		}
	}
	if permissionModeIDAllowedForProvider(ProviderCodex, "default") {
		t.Fatal("permission mode default accepted")
	}
}
