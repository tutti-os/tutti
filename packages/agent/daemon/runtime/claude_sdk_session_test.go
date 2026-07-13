package agentruntime

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestClaudeCodeSDKAdapterCanResumeRequiresProviderSessionID(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = ""
	if adapter.CanResume(session) {
		t.Fatal("CanResume without provider session id = true, want false")
	}
	session.ProviderSessionID = "claude-session-1"
	if !adapter.CanResume(session) {
		t.Fatal("CanResume with provider session id = false, want true")
	}
}

func TestClaudeCodeSDKAdapterResumeClassifiesMissingProviderSession(t *testing.T) {
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "00000000-0000-4000-8000-000000000000"
	err := classifyClaudeSDKResumeError(session, errors.New("Claude Code returned an error result: No conversation found with session ID: 00000000-0000-4000-8000-000000000000"))
	if AppErrorCode(err) != AppErrorProviderSessionNotFound {
		t.Fatalf("app error code = %q, want %q", AppErrorCode(err), AppErrorProviderSessionNotFound)
	}
}

func TestClaudeCodeSDKAdapterSessionStateSeedsCommandsAndCapabilities(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	commands, _ := state.RuntimeContext["commands"].([]string)
	for _, want := range []string{"compact", "status", "fast", "goal", "review"} {
		if !containsString(commands, want) {
			t.Fatalf("commands = %#v, missing %q", commands, want)
		}
	}
	capabilities, _ := state.RuntimeContext["capabilities"].([]string)
	for _, want := range []string{CapabilityImageInput, CapabilityCompact, CapabilityTokenUsage, CapabilityRateLimits, CapabilityPlanMode, CapabilityInterrupt, CapabilityActiveTurnGuidance, CapabilitySkills, "review"} {
		if !containsString(capabilities, want) {
			t.Fatalf("capabilities = %#v, missing %q", capabilities, want)
		}
	}
	snapshot, ok := adapter.SessionCommandSnapshot(session)
	if !ok || len(snapshot.Commands) == 0 {
		t.Fatalf("SessionCommandSnapshot = %#v ok=%v, want seeded commands", snapshot, ok)
	}
}

func TestClaudeCodeSDKAdapterSessionStateReflectsOptionalComposerCapabilities(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.Env = append(session.Env,
		browserUseEnabledEnv+"=1",
		computerUseEnabledEnv+"=true",
	)
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	capabilities, _ := state.RuntimeContext["capabilities"].([]string)
	for _, want := range []string{CapabilityBrowserUse, CapabilityComputerUse} {
		if !containsString(capabilities, want) {
			t.Fatalf("capabilities = %#v, missing %q", capabilities, want)
		}
	}
}

func TestClaudeCodeSDKAdapterSessionStateSeedsCanonicalSpeedConfigOption(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.Settings = &SessionSettings{Speed: "fast"}
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	if state.RuntimeContext["speed"] != "fast" {
		t.Fatalf("runtime speed = %#v, want fast", state.RuntimeContext["speed"])
	}
	if !hasClaudeSDKSpeedConfigOptions(state.RuntimeContext, "fast") {
		t.Fatalf("runtimeContext = %#v, want SDK speed config option set to fast", state.RuntimeContext)
	}
}

func TestClaudeCodeSDKAdapterRuntimeContextIncludesProviderConfig(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.Env = append(session.Env, "ANTHROPIC_BASE_URL=https://anthropic.proxy.test")
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	providerConfig, _ := state.RuntimeContext["providerConfig"].(map[string]any)
	if got, _ := providerConfig["baseUrl"].(string); got != "https://anthropic.proxy.test" {
		t.Fatalf("providerConfig = %#v, want SDK baseUrl", providerConfig)
	}
}

func TestClaudeCodeSDKAdapterStartSendsInitialSettings(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-1"}}` + "\n"),
		}},
	}
	transport := &recordingClaudeSDKTransport{conn: conn}
	adapter := NewClaudeCodeSDKAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-1"
	session.PermissionModeID = "bypassPermissions"
	session.Settings = &SessionSettings{
		Model:            "sonnet",
		PermissionModeID: "bypassPermissions",
		PlanMode:         true,
		ReasoningEffort:  "xhigh",
		Speed:            "fast",
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "start" {
		t.Fatalf("sent requests = %#v, want start", sent)
	}
	payload := sent[0].Payload
	if payload["permissionModeId"] != "bypassPermissions" {
		t.Fatalf("start payload permissionModeId = %#v", payload["permissionModeId"])
	}
	settings := payloadMap(payload, "settings")
	if settings["model"] != "sonnet" ||
		settings["permissionModeId"] != "bypassPermissions" ||
		settings["planMode"] != true ||
		settings["reasoningEffort"] != "xhigh" ||
		settings["speed"] != "fast" {
		t.Fatalf("start settings = %#v", settings)
	}
}

func TestClaudeCodeSDKAdapterProviderLaunchPrepareMutatesSpecAndCleansUpOnClose(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-1"}}` + "\n"),
		}},
	}
	transport := &recordingClaudeSDKTransport{conn: conn}
	adapter := NewClaudeCodeSDKAdapter(transport)
	cleanupCalls := 0
	adapter.SetProviderLaunchPreparer(func(_ context.Context, input ProviderLaunchPrepareInput) (ProviderLaunchPrepareResult, error) {
		if input.Provider != ProviderClaudeCode {
			t.Fatalf("Provider = %q, want %q", input.Provider, ProviderClaudeCode)
		}
		if !input.DirectStart {
			t.Fatal("DirectStart = false, want true for Claude SDK")
		}
		return ProviderLaunchPrepareResult{
			Command: []string{"prepared-node", "sidecar.ts"},
			Env:     append(append([]string(nil), input.Env...), "HOOK_ENV=1"),
			CWD:     "/prepared/claude-sdk",
			Cleanup: func(context.Context) error {
				cleanupCalls++
				return nil
			},
		}, nil
	})
	session := standardTestSession(ProviderClaudeCode)
	session.Env = []string{"SESSION_ENV=1"}
	session.ProviderSessionID = "provider-session-1"

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if cleanupCalls != 0 {
		t.Fatalf("cleanup calls before close = %d, want 0", cleanupCalls)
	}
	if !slices.Equal(transport.spec.Command, []string{"prepared-node", "sidecar.ts"}) {
		t.Fatalf("Command = %#v", transport.spec.Command)
	}
	if transport.spec.CWD != "/prepared/claude-sdk" {
		t.Fatalf("CWD = %q", transport.spec.CWD)
	}
	if !containsString(transport.spec.Env, "SESSION_ENV=1") || !containsString(transport.spec.Env, "HOOK_ENV=1") {
		t.Fatalf("Env = %#v, want session and hook env", transport.spec.Env)
	}

	if err := adapter.Close(context.Background(), session); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if cleanupCalls != 1 {
		t.Fatalf("cleanup calls after close = %d, want 1", cleanupCalls)
	}
	requests := conn.sentRequests()
	if len(requests) == 0 || requests[len(requests)-1].Type != "close" {
		t.Fatalf("last sidecar request = %#v, want close handshake", requests)
	}
}

func TestClaudeSDKSidecarCommandUsesVendoredEntryWithManagedNodeEnv(t *testing.T) {
	t.Setenv(claudeSDKSidecarCommandEnv, "")
	t.Setenv(claudeSDKSidecarEntryPathEnv, "")

	got := claudeSDKSidecarCommand([]string{
		claudeSDKAppNodeEnv + "=/runtime/node/bin/node",
		claudeSDKSidecarEntryPathEnv + "=/resources/bin/claude-sdk-sidecar/src/main.ts",
	})
	want := []string{"/runtime/node/bin/node", claudeSDKSidecarDefaultNodeArg, "/resources/bin/claude-sdk-sidecar/src/main.ts"}
	if !slices.Equal(got, want) {
		t.Fatalf("claudeSDKSidecarCommand() = %#v, want %#v", got, want)
	}
}

func TestClaudeSDKSidecarCommandUsesManagedNodeCacheRoot(t *testing.T) {
	t.Setenv(claudeSDKSidecarCommandEnv, "")
	t.Setenv(claudeSDKSidecarEntryPathEnv, "")

	cacheRoot := t.TempDir()
	nodePath := filepath.Join(cacheRoot, runtime.GOOS+"-"+runtime.GOARCH, "node", "bin", claudeSDKNodeBinaryName())
	if err := os.MkdirAll(filepath.Dir(nodePath), 0o755); err != nil {
		t.Fatalf("mkdir node dir: %v", err)
	}
	if err := os.WriteFile(nodePath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write node: %v", err)
	}

	got := claudeSDKSidecarCommand([]string{
		claudeSDKAppRuntimeCacheEnv + "=" + cacheRoot,
		claudeSDKSidecarEntryPathEnv + "=/resources/bin/claude-sdk-sidecar/src/main.ts",
	})
	want := []string{nodePath, claudeSDKSidecarDefaultNodeArg, "/resources/bin/claude-sdk-sidecar/src/main.ts"}
	if !slices.Equal(got, want) {
		t.Fatalf("claudeSDKSidecarCommand() = %#v, want %#v", got, want)
	}
}

func TestClaudeSDKSidecarCommandOverrideWinsOverVendoredEntry(t *testing.T) {
	t.Setenv(claudeSDKSidecarCommandEnv, "/custom/sidecar --flag")

	got := claudeSDKSidecarCommand([]string{
		claudeSDKAppNodeEnv + "=/runtime/node/bin/node",
		claudeSDKSidecarEntryPathEnv + "=/resources/bin/claude-sdk-sidecar/src/main.ts",
	})
	want := []string{"/custom/sidecar", "--flag"}
	if !slices.Equal(got, want) {
		t.Fatalf("claudeSDKSidecarCommand() = %#v, want %#v", got, want)
	}
}

func TestClaudeCodeSDKAdapterStartEnablesSandboxBypassEnv(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-1"}}` + "\n"),
		}},
	}
	transport := &recordingClaudeSDKTransport{conn: conn}
	adapter := NewClaudeCodeSDKAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !containsString(transport.spec.Env, "IS_SANDBOX=1") {
		t.Fatalf("env = %#v, want IS_SANDBOX=1 for Claude SDK bypassPermissions availability", transport.spec.Env)
	}
}

func TestClaudeCodeSDKAdapterStartSendsClaudeProviderMeta(t *testing.T) {
	systemPromptPath := filepath.Join(t.TempDir(), "claude-system-prompt.md")
	if err := os.WriteFile(systemPromptPath, []byte("Use Tutti CLI for issue context."), 0o600); err != nil {
		t.Fatal(err)
	}
	pluginDir := filepath.Join(t.TempDir(), "tutti-cli-plugin")
	if err := os.MkdirAll(pluginDir, 0o700); err != nil {
		t.Fatal(err)
	}
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-meta"}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(&recordingClaudeSDKTransport{conn: conn})
	session := standardTestSession(ProviderClaudeCode)
	session.Env = []string{
		claudeSystemPromptFileEnv + "=" + systemPromptPath,
		claudePluginDirEnv + "=" + pluginDir,
	}
	session.Settings = &SessionSettings{
		Model:            "MiniMax-M2.7",
		PermissionModeID: "default",
		PlanMode:         true,
	}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "start" {
		t.Fatalf("sent requests = %#v, want start", sent)
	}
	payload := sent[0].Payload
	if got, _ := payload["systemPromptAppend"].(string); got != "Use Tutti CLI for issue context." {
		t.Fatalf("systemPromptAppend = %q, want prompt file content", got)
	}
	if got, _ := payload["planModeInstructions"].(string); !strings.Contains(got, "do not edit files") || !strings.Contains(got, "implementation plan") {
		t.Fatalf("planModeInstructions = %#v, want Tutti plan workflow instructions", payload["planModeInstructions"])
	}
	allowedTools, ok := payload["allowedTools"].([]any)
	grepAllowed := false
	globAllowed := false
	for _, tool := range allowedTools {
		grepAllowed = grepAllowed || asString(tool) == "Grep"
		globAllowed = globAllowed || asString(tool) == "Glob"
	}
	if !ok || !grepAllowed || !globAllowed {
		t.Fatalf("allowedTools = %#v, want Grep and Glob enabled", payload["allowedTools"])
	}
	disallowedTools, ok := payload["disallowedTools"].([]any)
	monitorDisallowed := false
	for _, tool := range disallowedTools {
		monitorDisallowed = monitorDisallowed || asString(tool) == "Monitor"
	}
	if !ok || !monitorDisallowed {
		t.Fatalf("disallowedTools = %#v, want Monitor disabled", payload["disallowedTools"])
	}
	tools, ok := payload["tools"].(map[string]any)
	if !ok || tools["type"] != "preset" || tools["preset"] != "claude_code" {
		t.Fatalf("tools = %#v, want claude_code preset", payload["tools"])
	}
	plugins, ok := payload["plugins"].([]any)
	if !ok || len(plugins) != 1 {
		t.Fatalf("plugins = %#v, want local plugin dir", payload["plugins"])
	}
	plugin, _ := plugins[0].(map[string]any)
	if plugin["type"] != "local" || plugin["path"] != pluginDir {
		t.Fatalf("plugins = %#v, want local plugin dir", payload["plugins"])
	}
	extraArgs, ok := payload["extraArgs"].(map[string]any)
	if !ok || extraArgs["plugin-dir"] != pluginDir || extraArgs["model"] != "MiniMax-M2.7" {
		t.Fatalf("extraArgs = %#v, want plugin-dir and custom model", payload["extraArgs"])
	}
}

func TestClaudeCodeSDKAdapterStartFailsBeforeProcessForMissingClaudeMetaFiles(t *testing.T) {
	transport := &recordingClaudeSDKTransport{conn: &scriptedClaudeSDKConnection{}}
	adapter := NewClaudeCodeSDKAdapter(transport)
	session := standardTestSession(ProviderClaudeCode)
	session.Env = []string{claudeSystemPromptFileEnv + "=" + filepath.Join(t.TempDir(), "missing.md")}

	if _, err := adapter.Start(context.Background(), session); err == nil {
		t.Fatal("Start error = nil, want missing system prompt error")
	}
	if transport.spec.Command != nil {
		t.Fatalf("process spec = %#v, want no sidecar process start on invalid meta", transport.spec)
	}

	pluginTransport := &recordingClaudeSDKTransport{conn: &scriptedClaudeSDKConnection{}}
	pluginAdapter := NewClaudeCodeSDKAdapter(pluginTransport)
	pluginSession := standardTestSession(ProviderClaudeCode)
	pluginSession.Env = []string{claudePluginDirEnv + "=" + filepath.Join(t.TempDir(), "missing-plugin")}

	if _, err := pluginAdapter.Start(context.Background(), pluginSession); err == nil {
		t.Fatal("Start error = nil, want missing plugin dir error")
	}
	if pluginTransport.spec.Command != nil {
		t.Fatalf("process spec = %#v, want no sidecar process start on invalid plugin dir", pluginTransport.spec)
	}
}

func TestClaudeCodeSDKAdapterStartSendsResumeCursor(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"session_started","payload":{"providerSessionId":"provider-session-1","resumeCursor":{"kind":"claude-agent-sdk","version":1,"resume":"provider-session-1","resumeSessionAt":"assistant-1","turnCount":7}}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(&recordingClaudeSDKTransport{conn: conn})
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-1"
	session.RuntimeContext = map[string]any{
		"resumeCursor": map[string]any{
			"kind":            "claude-agent-sdk",
			"version":         int64(1),
			"resume":          "provider-session-1",
			"resumeSessionAt": "assistant-1",
			"turnCount":       int64(7),
		},
	}

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session started", events)
	}
	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "start" {
		t.Fatalf("sent requests = %#v, want start", sent)
	}
	cursor := payloadMap(sent[0].Payload, "resumeCursor")
	if cursor["resume"] != "provider-session-1" || cursor["resumeSessionAt"] != "assistant-1" {
		t.Fatalf("resume cursor payload = %#v", cursor)
	}
	stateCursor := payloadMap(events[0].Payload.Metadata, "resumeCursor")
	if stateCursor["resume"] != "provider-session-1" || stateCursor["resumeSessionAt"] != "assistant-1" {
		t.Fatalf("started runtime cursor = %#v", stateCursor)
	}
}

func TestClaudeCodeSDKAdapterSessionStateUpdatesResumeCursor(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapterSession := &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, adapterSession)

	events, terminal, err := adapter.sidecarTurnEvents(adapterSession, session, "turn-1", claudeSDKSidecarEvent{
		Type: "session_state",
		Payload: map[string]any{
			"providerSessionId": "provider-session-2",
			"resumeCursor": map[string]any{
				"kind":            "claude-agent-sdk",
				"version":         int64(1),
				"resume":          "provider-session-2",
				"resumeSessionAt": "assistant-2",
				"turnCount":       int64(3),
			},
		},
	})
	if err != nil || terminal {
		t.Fatalf("session_state terminal=%v err=%v", terminal, err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionUpdated {
		t.Fatalf("events = %#v, want session.updated", events)
	}
	if adapterSession.providerSessionID != "provider-session-2" {
		t.Fatalf("provider session id = %q, want updated", adapterSession.providerSessionID)
	}
	state := adapter.SessionState(session)
	cursor := payloadMap(state.RuntimeContext, "resumeCursor")
	if cursor["resume"] != "provider-session-2" || cursor["resumeSessionAt"] != "assistant-2" {
		t.Fatalf("runtime cursor = %#v", cursor)
	}
}

func TestClaudeCodeSDKAdapterResumeFailureRestoresPreviousLiveSession(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"error","payload":{"error":"No conversation found with session ID: provider-session-1"}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(&recordingClaudeSDKTransport{conn: conn})
	session := standardTestSession(ProviderClaudeCode)
	session.ProviderSessionID = "provider-session-1"
	previous := &claudeSDKAdapterSession{
		conn:              &recordingClaudeSDKConnection{},
		providerSessionID: "previous-live-session",
		liveState:         newClaudeSDKLiveState(),
	}
	adapter.storeSession(session.AgentSessionID, previous)

	err := adapter.Resume(context.Background(), session)
	if AppErrorCode(err) != AppErrorProviderSessionNotFound {
		t.Fatalf("Resume error = %v, want provider session not found", err)
	}
	if got := adapter.getSession(session.AgentSessionID); got != previous {
		t.Fatalf("live session not restored after failed resume")
	}
}

func TestClaudeCodeSDKAdapterSessionStateProjectsSettings(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	session.PermissionModeID = "auto"
	session.Settings = &SessionSettings{
		Model:            "sonnet",
		PermissionModeID: "auto",
		ReasoningEffort:  "xhigh",
		Speed:            "fast",
		PlanMode:         true,
	}
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		providerSessionID: "provider-session-1",
		liveState:         newClaudeSDKLiveState(),
	})

	state := adapter.SessionState(session)
	if state.RuntimeContext["model"] != "sonnet" ||
		state.RuntimeContext["permissionModeId"] != "auto" ||
		state.RuntimeContext["reasoningEffort"] != "xhigh" ||
		state.RuntimeContext["speed"] != "fast" ||
		state.RuntimeContext["planMode"] != true {
		t.Fatalf("runtimeContext settings = %#v", state.RuntimeContext)
	}
	if !hasClaudeSDKEffortConfigOptions(state.RuntimeContext, "xhigh") {
		t.Fatalf("runtimeContext = %#v, want SDK effort config option set to xhigh", state.RuntimeContext)
	}
}

func TestClaudeCodeSDKAdapterAcceptsImagePromptContent(t *testing.T) {
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)

	if err := adapter.ValidatePromptContent(session, []PromptContentBlock{
		{Type: "text", Text: "what is in this image?"},
		{Type: "image", MimeType: "image/png", Data: "aW1hZ2U="},
	}); err != nil {
		t.Fatalf("ValidatePromptContent supported image = %v, want nil", err)
	}
	if err := adapter.ValidatePromptContent(session, []PromptContentBlock{
		{Type: "image", MimeType: "image/png", Path: "/managed/agent-prompt-assets/screen.png"},
	}); err != nil {
		t.Fatalf("ValidatePromptContent path-backed image = %v, want nil", err)
	}
	if err := adapter.ValidatePromptContent(session, []PromptContentBlock{
		{Type: "image", MimeType: "image/gif", Data: "aW1hZ2U="},
	}); !errors.Is(err, ErrPromptImageUnsupported) {
		t.Fatalf("ValidatePromptContent unsupported image = %v, want ErrPromptImageUnsupported", err)
	}
}

func TestClaudeCodeSDKAdapterExecSendsStructuredPromptContent(t *testing.T) {
	conn := &scriptedClaudeSDKConnection{
		frames: []ProcessFrame{{
			Stdout: []byte(`{"type":"turn_completed","payload":{"turnId":"turn-image","stopReason":"end_turn"}}` + "\n"),
		}},
	}
	adapter := NewClaudeCodeSDKAdapter(nil)
	session := standardTestSession(ProviderClaudeCode)
	adapter.storeSession(session.AgentSessionID, &claudeSDKAdapterSession{
		conn:              conn,
		reader:            &claudeSDKLineReader{conn: conn},
		providerSessionID: "provider-session-1",
		pendingRequests:   make(map[string]*pendingInteractiveRequest),
		liveState:         newClaudeSDKLiveState(),
	})

	if _, err := adapter.Exec(
		context.Background(),
		session,
		[]PromptContentBlock{
			{Type: "text", Text: "what is in this image?"},
			{Type: "image", MimeType: "image/png", Data: "aW1hZ2U="},
		},
		"what is in this image?",
		"turn-image",
		nil,
		nil,
	); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	sent := conn.sentRequests()
	if len(sent) != 1 || sent[0].Type != "exec" {
		t.Fatalf("sent requests = %#v, want one exec", sent)
	}
	if sent[0].Payload["prompt"] != "what is in this image?" {
		t.Fatalf("exec prompt = %#v, want legacy text prompt", sent[0].Payload["prompt"])
	}
	content, ok := sent[0].Payload["content"].([]any)
	if !ok || len(content) != 2 {
		t.Fatalf("exec content = %#v, want text and image blocks", sent[0].Payload["content"])
	}
	textBlock, _ := content[0].(map[string]any)
	if textBlock["type"] != "text" || textBlock["text"] != "what is in this image?" {
		t.Fatalf("text block = %#v", textBlock)
	}
	imageBlock, _ := content[1].(map[string]any)
	if imageBlock["type"] != "image" || imageBlock["mimeType"] != "image/png" || imageBlock["data"] != "aW1hZ2U=" {
		t.Fatalf("image block = %#v", imageBlock)
	}
}
