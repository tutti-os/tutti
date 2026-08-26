package agentruntime

import (
	"encoding/json"
	"strings"
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
		providerAdapterOptions{},
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
	adapter := newAdapterFromProviderDescriptor(
		descriptor,
		nil,
		HostMetadata{},
		nil,
		providerAdapterOptions{},
	)
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
	if adapter.config.rateLimits {
		t.Fatal("Tutti Agent adapter must not probe ChatGPT rate limits")
	}
	if capabilities := capabilitySnapshotValues(adapter.SessionState(Session{AgentSessionID: "missing"}).Capabilities); len(capabilities) != 0 {
		t.Fatalf("empty session capabilities = %#v, want nil", capabilities)
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

func TestMigratedOpenCodeDescriptorOwnsPermissionModes(t *testing.T) {
	if got := defaultPermissionModeIDForProvider(ProviderOpenCode); got != "ask" {
		t.Fatalf("default permission mode = %q, want ask", got)
	}
	for _, mode := range []string{"read-only", "ask", "full-access"} {
		if !permissionModeIDAllowedForProvider(ProviderOpenCode, mode) {
			t.Fatalf("permission mode %q rejected", mode)
		}
	}
	for _, workflowMode := range []string{"build", "plan"} {
		if permissionModeIDAllowedForProvider(ProviderOpenCode, workflowMode) {
			t.Fatalf("workflow mode %q accepted as a permission mode", workflowMode)
		}
	}
}

func TestMigratedOpenCodeDescriptorBuildsStandardACPAdapter(t *testing.T) {
	descriptor, ok := providerregistry.Find(ProviderOpenCode)
	if !ok {
		t.Fatal("opencode descriptor missing")
	}
	descriptor.Runtime.Name = "descriptor-opencode-acp"
	descriptor.Runtime.Command = []string{"descriptor-opencode", "acp"}
	descriptor.Runtime.StandardACP.PlanModeDisabledRuntimeID = "descriptor-build"
	descriptor.Runtime.StandardACP.SettingsEnvironment.Variable = "DESCRIPTOR_CONFIG"
	descriptor.Runtime.StandardACP.SettingsEnvironment.JSONFields[0].JSONKey = "descriptorModel"
	adapter := newAdapterFromProviderDescriptor(
		descriptor,
		nil,
		LegacyHostMetadata(),
		nil,
		providerAdapterOptions{},
	)
	standardAdapter, ok := adapter.(*standardACPAdapter)
	if !ok {
		t.Fatalf("adapter type = %T", adapter)
	}
	if standardAdapter.Provider() != ProviderOpenCode ||
		standardAdapter.config.adapterName != "descriptor-opencode-acp" ||
		standardAdapter.config.command[0] != "descriptor-opencode" ||
		standardAdapter.config.planModeDisabledRuntimeID != "descriptor-build" ||
		standardAdapter.config.permissionModeID("ask") != "" {
		t.Fatalf("adapter config = %#v", standardAdapter.config)
	}
	session := standardTestSession(ProviderOpenCode)
	session.Settings = &SessionSettings{Model: "openai/descriptor-model"}
	environment, err := standardAdapter.config.finalizeEnv(standardAdapter.config.env(session), session)
	if err != nil {
		t.Fatalf("finalize descriptor environment: %v", err)
	}
	var descriptorConfig map[string]any
	for _, item := range environment {
		if !strings.HasPrefix(item, "DESCRIPTOR_CONFIG=") {
			continue
		}
		if err := json.Unmarshal([]byte(strings.TrimPrefix(item, "DESCRIPTOR_CONFIG=")), &descriptorConfig); err != nil {
			t.Fatalf("decode descriptor config: %v", err)
		}
	}
	if descriptorConfig["descriptorModel"] != "openai/descriptor-model" {
		t.Fatalf("adapter environment = %#v", environment)
	}
}

func TestNewStandardACPAdapterAppliesTrustedApprovalDeferralBehavior(t *testing.T) {
	t.Parallel()

	tests := []struct {
		provider string
		want     bool
	}{
		{provider: "acp:kimi-code", want: true},
		{provider: ProviderCursor, want: false},
	}
	for _, test := range tests {
		t.Run(test.provider, func(t *testing.T) {
			t.Parallel()
			adapterValue, err := NewStandardACPAdapter(StandardACPAdapterConfig{
				Provider: test.provider,
				Name:     "extension-acp",
				Command:  []string{"extension", "acp"},
			}, nil, LegacyHostMetadata())
			if err != nil {
				t.Fatalf("NewStandardACPAdapter: %v", err)
			}
			adapter := adapterValue.(*standardACPAdapter)
			if got := adapter.config.deferApprovalUntilToolInput; got != test.want {
				t.Fatalf("deferApprovalUntilToolInput=%v, want %v", got, test.want)
			}
		})
	}
}

func TestDefaultControllerRegistersOpenCodeFromMigratedDescriptor(t *testing.T) {
	controller := NewDefaultControllerWithProcessTransport(nil, nil)
	adapter, ok := controller.adapters[ProviderOpenCode].(*standardACPAdapter)
	if !ok {
		t.Fatalf("opencode adapter = %T, want *standardACPAdapter", controller.adapters[ProviderOpenCode])
	}
	descriptor, ok := providerregistry.Find(ProviderOpenCode)
	if !ok {
		t.Fatal("opencode descriptor missing")
	}
	if adapter.config.adapterName != descriptor.Runtime.Name ||
		!strings.EqualFold(adapter.config.command[0], descriptor.Runtime.Command[0]) {
		t.Fatalf("adapter config = %#v, descriptor runtime = %#v", adapter.config, descriptor.Runtime)
	}
}

func TestDefaultControllerRegistersEveryMigratedProviderDescriptor(t *testing.T) {
	controller := NewDefaultControllerWithProcessTransport(nil, nil)
	for _, descriptor := range providerregistry.Migrated() {
		adapter := controller.adapters[descriptor.Identity.ID]
		if adapter == nil {
			t.Fatalf("provider %q has no default controller adapter", descriptor.Identity.ID)
		}
		if adapter.Provider() != descriptor.Identity.ID {
			t.Fatalf("provider %q constructed adapter for %q", descriptor.Identity.ID, adapter.Provider())
		}
	}
	if len(controller.adapters) != len(providerregistry.Migrated()) {
		t.Fatalf("controller adapters = %d, migrated descriptors = %d", len(controller.adapters), len(providerregistry.Migrated()))
	}
}

func TestDefaultControllerAppliesCommandNetworkAccessPolicyOnlyToSelectedAppServerProvider(t *testing.T) {
	policyProviders := make(map[string]int)
	controller := NewDefaultControllerWithOptions(nil, nil, ControllerOptions{
		HostMetadata: LegacyHostMetadata(),
		CommandNetworkAccessPolicy: func(provider string) bool {
			policyProviders[provider]++
			return provider == ProviderTuttiAgent
		},
	})

	codexAdapter, ok := controller.adapters[ProviderCodex].(*CodexAppServerAdapter)
	if !ok {
		t.Fatalf("codex adapter = %T, want *CodexAppServerAdapter", controller.adapters[ProviderCodex])
	}
	if codexAdapter.config.commandNetworkAccess {
		t.Fatal("Codex command network access = true, want false")
	}
	tuttiAgentAdapter, ok := controller.adapters[ProviderTuttiAgent].(*CodexAppServerAdapter)
	if !ok {
		t.Fatalf(
			"Tutti Agent adapter = %T, want *CodexAppServerAdapter",
			controller.adapters[ProviderTuttiAgent],
		)
	}
	if !tuttiAgentAdapter.config.commandNetworkAccess {
		t.Fatal("Tutti Agent command network access = false, want true")
	}
	if policyProviders[ProviderCodex] != 1 ||
		policyProviders[ProviderTuttiAgent] != 1 ||
		len(policyProviders) != 2 {
		t.Fatalf("command network access policy providers = %#v", policyProviders)
	}
}
