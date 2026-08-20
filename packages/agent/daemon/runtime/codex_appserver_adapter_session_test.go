package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	"slices"
	"testing"
	"time"
)

func TestCodexAppServerAdapterStartCreatesThread(t *testing.T) {
	t.Parallel()

	adapter, transport, _ := startedAppServerAdapter(t)
	if len(transport.specs) != 1 {
		t.Fatalf("process starts = %d, want 1", len(transport.specs))
	}
	spec := transport.specs[0]
	descriptor := codexProviderDescriptorForTest(t)
	wantCommand := descriptor.Runtime.Command
	if len(spec.Command) != 2 || spec.Command[0] != wantCommand[0] || spec.Command[1] != wantCommand[1] {
		t.Fatalf("command = %#v, want %#v", spec.Command, wantCommand)
	}
	if spec.CWD != "/workspace" {
		t.Fatalf("cwd = %q, want /workspace (workspace-mapped)", spec.CWD)
	}
	if !containsString(spec.Env, codexAgentRoutingEnv) {
		t.Fatalf("env = %#v, want agent routing env", spec.Env)
	}
	if !containsString(spec.Env, codexAppServerLogFormatEnv) {
		t.Fatalf("env = %#v, want structured Codex logs", spec.Env)
	}
	if !containsString(spec.Env, codexAppServerRustLogEnv) {
		t.Fatalf("env = %#v, want Codex startup span log level", spec.Env)
	}

	initialize := appServerRequestParams(t, transport.conn, appServerMethodInitialize)
	clientInfo, _ := initialize["clientInfo"].(map[string]any)
	if asString(clientInfo["name"]) != descriptor.Runtime.ClientInfoName || asString(clientInfo["version"]) == "" {
		t.Fatalf("initialize clientInfo = %#v, want name=%q + non-empty version",
			initialize["clientInfo"], descriptor.Runtime.ClientInfoName)
	}
	capabilities, _ := initialize["capabilities"].(map[string]any)
	if experimental, _ := capabilities["experimentalApi"].(bool); !experimental {
		t.Fatalf("initialize capabilities = %#v, want experimentalApi=true", initialize["capabilities"])
	}
	if params := appServerRequestParamsList(t, transport.conn, appServerMethodInitialized); len(params) != 1 {
		t.Fatalf("initialized notifications = %d, want 1", len(params))
	}
	threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
	if asString(threadStart["cwd"]) != "/workspace" {
		t.Fatalf("thread/start cwd = %q, want /workspace", threadStart["cwd"])
	}
	state := adapter.SessionState(testAppServerSession())
	if state.AuthState != "authenticated" {
		t.Fatalf("auth state = %q, want authenticated", state.AuthState)
	}
}

func TestCodexAppServerAdapterStartClampsProviderDefaultReasoning(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.Settings = &SessionSettings{ReasoningEffort: "ultra"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
	if got := asString(threadStart["model"]); got != "gpt-5.1-codex" {
		t.Fatalf("thread/start model = %q, want gpt-5.1-codex", got)
	}
	config, _ := threadStart["config"].(map[string]any)
	if got := asString(config["model_reasoning_effort"]); got != "medium" {
		t.Fatalf("thread/start reasoning effort = %q, want medium", got)
	}
}

func TestCodexAppServerAdapterStartClampsPersistedReasoningForExplicitModel(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.Settings = &SessionSettings{
		Model:           "gpt-5.1-codex-mini",
		ReasoningEffort: "high",
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodModelList); len(requests) != 1 {
		t.Fatalf("model/list requests = %d, want 1 to validate persisted reasoning", len(requests))
	}
	threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
	if got := asString(threadStart["model"]); got != "gpt-5.1-codex-mini" {
		t.Fatalf("thread/start model = %q, want gpt-5.1-codex-mini", got)
	}
	config, _ := threadStart["config"].(map[string]any)
	if got := asString(config["model_reasoning_effort"]); got != "medium" {
		t.Fatalf("thread/start reasoning effort = %q, want catalog default medium", got)
	}
	state := adapter.SessionState(session)
	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	reasoning := configOptionByID(options, "reasoning_effort")
	if got := configOptionValues(reasoning); !slices.Equal(got, []string{"low", "medium"}) {
		t.Fatalf("hidden current model reasoning options = %#v, want catalog profile", got)
	}
}

func TestCodexAppServerAdapterResumeClampsPersistedReasoningBeforeRequest(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.ProviderSessionID = "codex-thread-1"
	session.Settings = &SessionSettings{
		Model:           "gpt-5.1-codex-mini",
		ReasoningEffort: "high",
	}
	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	threadResume := appServerRequestParams(t, transport.conn, appServerMethodThreadResume)
	config, _ := threadResume["config"].(map[string]any)
	if got := asString(config["model_reasoning_effort"]); got != "medium" {
		t.Fatalf("thread/resume reasoning effort = %q, want catalog default medium", got)
	}
}

func TestCodexAppServerAdapterResumeDoesNotInferModelOverrideForPersistedReasoning(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.server.modelList = []any{map[string]any{
		"id":                        "gpt-current-default",
		"model":                     "gpt-current-default",
		"isDefault":                 true,
		"defaultReasoningEffort":    "medium",
		"supportedReasoningEfforts": []any{"low", "medium"},
	}}
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.ProviderSessionID = "codex-thread-1"
	session.Settings = &SessionSettings{ReasoningEffort: "ultra"}

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	threadResume := appServerRequestParams(t, transport.conn, appServerMethodThreadResume)
	if got := asString(threadResume["model"]); got != "" {
		t.Fatalf("thread/resume model = %q, want existing thread model preserved", got)
	}
	config, _ := threadResume["config"].(map[string]any)
	if got := asString(config["model_reasoning_effort"]); got != "medium" {
		t.Fatalf("thread/resume reasoning effort = %q, want catalog default medium", got)
	}
	state := adapter.SessionState(session)
	if state.Settings == nil || state.Settings.Model != "gpt-5.1-codex" {
		t.Fatalf("resumed settings = %#v, want model reported by existing thread", state.Settings)
	}
}

func TestCodexAppServerAdapterStartUsesModelFieldForCatalogDefault(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.server.modelList = []any{map[string]any{
		"id":                        "catalog-record-id",
		"model":                     "gpt-default-api-name",
		"displayName":               "Default API Model",
		"isDefault":                 true,
		"defaultReasoningEffort":    "high",
		"supportedReasoningEfforts": []any{"low", "high"},
	}}
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.Settings = &SessionSettings{ReasoningEffort: "ultra"}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}

	threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
	if got := asString(threadStart["model"]); got != "gpt-default-api-name" {
		t.Fatalf("thread/start model = %q, want catalog model field", got)
	}
	config, _ := threadStart["config"].(map[string]any)
	if got := asString(config["model_reasoning_effort"]); got != "high" {
		t.Fatalf("thread/start reasoning effort = %q, want model-specific default high", got)
	}
	state := adapter.SessionState(session)
	options, _ := state.RuntimeContext["configOptions"].([]map[string]any)
	modelOption := configOptionByID(options, "model")
	if got := asString(modelOption["currentValue"]); got != "gpt-default-api-name" {
		t.Fatalf("model current value = %q, want catalog model field", got)
	}
	reasoningOption := configOptionByID(options, "reasoning_effort")
	if got := configOptionValues(reasoningOption); !slices.Equal(got, []string{"low", "high"}) {
		t.Fatalf("reasoning options = %#v, want model-specific catalog values", got)
	}
}

func TestCodexClientInfoParamsPresentsOfficialOriginator(t *testing.T) {
	t.Parallel()

	// A resolved codex version is used verbatim and overrides the host name,
	// so the outbound originator/User-Agent match the genuine codex_cli_rs.
	host := HostMetadata{ClientInfo: ClientInfo{Name: "tutti-desktop", Title: "Tutti", Version: "0.1.0"}}
	descriptor := codexProviderDescriptorForTest(t)
	got := clientInfoParamsForVersion(host, descriptor.Runtime.ClientInfoName, "1.2.3")

	if got["name"] != descriptor.Runtime.ClientInfoName {
		t.Fatalf("name = %v, want %q (official originator, not the host name)", got["name"], descriptor.Runtime.ClientInfoName)
	}
	if got["version"] != "1.2.3" {
		t.Fatalf("version = %v, want the resolved codex version 1.2.3 (not host %q)", got["version"], host.ClientInfo.Version)
	}
	if got["title"] != "Tutti" {
		t.Fatalf("title = %v, want Tutti (passed through from host)", got["title"])
	}
}

func TestCodexClientInfoParamsFallsBackToHostVersion(t *testing.T) {
	t.Parallel()

	// When the codex version cannot be resolved, fall back to the host version
	// rather than emitting a blank version segment.
	host := HostMetadata{ClientInfo: ClientInfo{Name: "tutti-desktop", Title: "Tutti", Version: "9.9.9"}}
	descriptor := codexProviderDescriptorForTest(t)
	got := clientInfoParamsForVersion(host, descriptor.Runtime.ClientInfoName, "")

	if got["name"] != descriptor.Runtime.ClientInfoName {
		t.Fatalf("name = %v, want %q", got["name"], descriptor.Runtime.ClientInfoName)
	}
	if got["version"] != "9.9.9" {
		t.Fatalf("version = %v, want host fallback 9.9.9", got["version"])
	}
}

func TestCodexAppServerAdapterWireFormatOmitsJSONRPCVersion(t *testing.T) {
	t.Parallel()

	_, transport, _ := startedAppServerAdapter(t)
	transport.conn.mu.Lock()
	defer transport.conn.mu.Unlock()
	for _, data := range transport.conn.sent {
		for _, line := range acpScanLines(data) {
			var message map[string]any
			if err := json.Unmarshal([]byte(line), &message); err != nil {
				t.Fatalf("unmarshal sent line: %v", err)
			}
			if _, found := message["jsonrpc"]; found {
				t.Fatalf("sent message includes jsonrpc version header: %s", line)
			}
		}
	}
}

func TestCodexAppServerAdapterStartAppliesSettingsAndPermissionMode(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.PermissionModeID = "read-only"
	session.Settings = &SessionSettings{
		Model:            "gpt-5.3-codex-spark",
		ReasoningEffort:  "xhigh",
		PermissionModeID: "read-only",
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
	if asString(threadStart["model"]) != "gpt-5.3-codex-spark" {
		t.Fatalf("thread/start model = %q", threadStart["model"])
	}
	if asString(threadStart["approvalPolicy"]) != "on-request" {
		t.Fatalf("thread/start approvalPolicy = %q, want on-request", threadStart["approvalPolicy"])
	}
	if asString(threadStart["sandbox"]) != "read-only" {
		t.Fatalf("thread/start sandbox = %q, want read-only", threadStart["sandbox"])
	}
	if asString(threadStart["approvalsReviewer"]) != "user" {
		t.Fatalf("thread/start approvalsReviewer = %q, want user", threadStart["approvalsReviewer"])
	}
	config, _ := threadStart["config"].(map[string]any)
	if asString(config["model_reasoning_effort"]) != "xhigh" {
		t.Fatalf("thread/start config = %#v, want model_reasoning_effort=xhigh", config)
	}
	if asString(config["model_reasoning_summary"]) != "auto" {
		t.Fatalf("thread/start config = %#v, want reasoning summaries enabled for inline review on spark", config)
	}
}

func TestCodexAppServerAdapterCommandNetworkAccessPreservesPermissionModes(t *testing.T) {
	t.Parallel()

	testAppServerAdapterCommandNetworkAccessPreservesPermissionModes(
		t,
		func(transport ProcessTransport) *CodexAppServerAdapter {
			return NewCodexAppServerAdapterWithHostMetadataAndOptions(
				transport,
				LegacyHostMetadata(),
				CodexAppServerAdapterOptions{CommandNetworkAccess: true},
			)
		},
	)
}

func TestTuttiAgentAppServerAdapterCommandNetworkAccessPreservesPermissionModes(t *testing.T) {
	t.Parallel()

	testAppServerAdapterCommandNetworkAccessPreservesPermissionModes(
		t,
		func(transport ProcessTransport) *CodexAppServerAdapter {
			return NewTuttiAgentAppServerAdapterWithHostMetadataAndOptions(
				transport,
				LegacyHostMetadata(),
				CodexAppServerAdapterOptions{CommandNetworkAccess: true},
			)
		},
	)
}

func testAppServerAdapterCommandNetworkAccessPreservesPermissionModes(
	t *testing.T,
	newAdapter func(ProcessTransport) *CodexAppServerAdapter,
) {
	t.Helper()
	tests := []struct {
		mode              string
		threadSandbox     string
		turnSandbox       string
		approvalPolicy    string
		approvalsReviewer string
	}{
		{
			mode:              "read-only",
			threadSandbox:     "read-only",
			turnSandbox:       "readOnly",
			approvalPolicy:    "on-request",
			approvalsReviewer: "user",
		},
		{
			mode:              "auto",
			threadSandbox:     "workspace-write",
			turnSandbox:       "workspaceWrite",
			approvalPolicy:    "on-request",
			approvalsReviewer: "auto_review",
		},
		{
			mode:           "full-access",
			threadSandbox:  "danger-full-access",
			turnSandbox:    "dangerFullAccess",
			approvalPolicy: "never",
		},
	}
	for _, test := range tests {
		t.Run(test.mode, func(t *testing.T) {
			t.Parallel()

			transport := newScriptedAppServerTransport()
			adapter := newAdapter(transport)
			session := testAppServerSession()
			session.PermissionModeID = test.mode
			session.Settings = &SessionSettings{PermissionModeID: test.mode}

			if _, err := adapter.Start(context.Background(), session); err != nil {
				t.Fatalf("Start: %v", err)
			}
			threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
			if got := asString(threadStart["sandbox"]); got != test.threadSandbox {
				t.Fatalf("thread/start sandbox = %q, want %q", got, test.threadSandbox)
			}
			if got := asString(threadStart["approvalPolicy"]); got != test.approvalPolicy {
				t.Fatalf("thread/start approvalPolicy = %q, want %q", got, test.approvalPolicy)
			}
			if got := asString(threadStart["approvalsReviewer"]); got != test.approvalsReviewer {
				t.Fatalf("thread/start approvalsReviewer = %q, want %q", got, test.approvalsReviewer)
			}

			if _, err := adapter.Exec(context.Background(), session, textPrompt("go"), "", "turn-local-1", nil, nil); err != nil {
				t.Fatalf("Exec: %v", err)
			}
			turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
			policy, _ := turnStart["sandboxPolicy"].(map[string]any)
			if got := asString(policy["type"]); got != test.turnSandbox {
				t.Fatalf("turn/start sandboxPolicy = %#v, want type %q", policy, test.turnSandbox)
			}
			if test.mode == "full-access" {
				if _, ok := policy["networkAccess"]; ok {
					t.Fatalf("turn/start sandboxPolicy = %#v, want implicit full-access networking", policy)
				}
			} else if enabled, _ := policy["networkAccess"].(bool); !enabled {
				t.Fatalf("turn/start sandboxPolicy = %#v, want networkAccess=true", policy)
			}
		})
	}
}

func TestCodexAppServerAdapterDefaultCommandNetworkAccessRemainsDisabled(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.PermissionModeID = "read-only"
	session.Settings = &SessionSettings{PermissionModeID: "read-only"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := adapter.Exec(context.Background(), session, textPrompt("go"), "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	policy, _ := turnStart["sandboxPolicy"].(map[string]any)
	if _, ok := policy["networkAccess"]; ok {
		t.Fatalf("turn/start sandboxPolicy = %#v, want legacy network default", policy)
	}
}

func TestTuttiAgentAppServerAdapterDefaultCommandNetworkAccessRemainsDisabled(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewTuttiAgentAppServerAdapterWithHostMetadata(transport, LegacyHostMetadata())
	session := testAppServerSession()
	session.PermissionModeID = "read-only"
	session.Settings = &SessionSettings{PermissionModeID: "read-only"}

	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := adapter.Exec(context.Background(), session, textPrompt("go"), "", "turn-local-1", nil, nil); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	turnStart := appServerRequestParams(t, transport.conn, appServerMethodTurnStart)
	policy, _ := turnStart["sandboxPolicy"].(map[string]any)
	if _, ok := policy["networkAccess"]; ok {
		t.Fatalf("turn/start sandboxPolicy = %#v, want legacy network default", policy)
	}
}

func TestCodexAppServerReasoningEffortValuePreservesCatalogValues(t *testing.T) {
	t.Parallel()

	if got := codexACPReasoningEffortValue("max"); got != "xhigh" {
		t.Fatalf("legacy codexACPReasoningEffortValue(max) = %q, want xhigh", got)
	}
	for _, value := range []string{"max", "ultra", "deep", "none"} {
		if got := codexAppServerReasoningEffortValue(value); got != value {
			t.Fatalf("codexAppServerReasoningEffortValue(%q) = %q, want %q", value, got, value)
		}
	}
}

func TestAppServerThreadStartParamsPreservesCatalogReasoningEffort(t *testing.T) {
	t.Parallel()

	for _, effort := range []string{"max", "deep"} {
		session := testAppServerSession()
		session.Settings = &SessionSettings{Model: "gpt-5.6-sol", ReasoningEffort: effort}
		params := appServerThreadStartParams(session, "/workspace")
		config, _ := params["config"].(map[string]any)
		if got := asString(config["model_reasoning_effort"]); got != effort {
			t.Fatalf("thread/start reasoning effort = %q, want %q", got, effort)
		}
	}
}

func TestAppServerReasoningEffortForModelPreservesAdvertisedValue(t *testing.T) {
	t.Parallel()

	models := []map[string]any{{
		"id":                        "gpt-future",
		"defaultReasoningEffort":    "medium",
		"supportedReasoningEfforts": []any{"low", "medium", "deep"},
	}}
	if got := appServerReasoningEffortForModel(models, "gpt-future", "deep"); got != "deep" {
		t.Fatalf("appServerReasoningEffortForModel(deep) = %q, want deep", got)
	}
}

func TestAppServerReasoningEffortForModelHonorsAdvertisedEmptyList(t *testing.T) {
	t.Parallel()

	models := []map[string]any{{
		"model":                     "gpt-no-reasoning",
		"supportedReasoningEfforts": []any{},
	}}
	if got := appServerReasoningEffortForModel(models, "gpt-no-reasoning", "high"); got != "" {
		t.Fatalf("appServerReasoningEffortForModel(high) = %q, want empty", got)
	}
	descriptors := codexAppServerConfigOptionDescriptors(models, Session{
		Settings: &SessionSettings{Model: "gpt-no-reasoning", ReasoningEffort: "high"},
	}, nil)
	option := configOptionByID(descriptors, "reasoning_effort")
	if option == nil {
		t.Fatalf("reasoning descriptor missing, want explicit empty live profile")
	}
	if value, ok := option["currentValue"]; !ok || value != nil {
		t.Fatalf("reasoning currentValue = %#v, want nil tombstone", value)
	}
	if values := configOptionValues(option); len(values) != 0 {
		t.Fatalf("reasoning options = %#v, want advertised empty list", values)
	}
}

func TestCodexAppServerAdapterStartAutoPermissionUsesAutoReviewer(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.PermissionModeID = "auto"
	session.Settings = &SessionSettings{
		PermissionModeID: "auto",
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	threadStart := appServerRequestParams(t, transport.conn, appServerMethodThreadStart)
	if asString(threadStart["approvalPolicy"]) != "on-request" {
		t.Fatalf("thread/start approvalPolicy = %q, want on-request", threadStart["approvalPolicy"])
	}
	if asString(threadStart["sandbox"]) != "workspace-write" {
		t.Fatalf("thread/start sandbox = %q, want workspace-write", threadStart["sandbox"])
	}
	if asString(threadStart["approvalsReviewer"]) != "auto_review" {
		t.Fatalf("thread/start approvalsReviewer = %q, want auto_review", threadStart["approvalsReviewer"])
	}
}

func TestCodexAppServerAdapterStartAuthRequired(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.server.requiresAuth = true
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()

	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if len(events) != 1 || events[0].Type != activityshared.EventSessionStarted {
		t.Fatalf("events = %#v, want session.started", events)
	}
	if got := asString(events[0].Payload.Metadata["authState"]); got != "auth_required" {
		t.Fatalf("authState = %q, want auth_required", got)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodThreadStart); len(requests) != 0 {
		t.Fatalf("thread/start requests = %d, want 0 when auth is required", len(requests))
	}
	state := adapter.SessionState(session)
	if state.AuthState != "auth_required" {
		t.Fatalf("session auth state = %q, want auth_required", state.AuthState)
	}
	if asString(state.RuntimeContext["authMessage"]) == "" {
		t.Fatalf("runtime context missing authMessage: %#v", state.RuntimeContext)
	}
}

func TestCodexAppServerAdapterStartToleratesAccountReadError(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.server.accountReadError = true
	adapter := NewCodexAppServerAdapter(transport)
	if _, err := adapter.Start(context.Background(), testAppServerSession()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if requests := appServerRequestParamsList(t, transport.conn, appServerMethodThreadStart); len(requests) != 1 {
		t.Fatalf("thread/start requests = %d, want 1", len(requests))
	}
}

func TestCodexAppServerAdapterResume(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.ProviderSessionID = "codex-thread-1"

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	resume := appServerRequestParams(t, transport.conn, appServerMethodThreadResume)
	if asString(resume["threadId"]) != "codex-thread-1" {
		t.Fatalf("thread/resume threadId = %q", resume["threadId"])
	}
	if asString(resume["cwd"]) != "/workspace" {
		t.Fatalf("thread/resume cwd = %q, want /workspace", resume["cwd"])
	}
	if got := asString(resume["model"]); got != "" {
		t.Fatalf("thread/resume model = %q, want existing thread setting", got)
	}
	if config, ok := resume["config"].(map[string]any); ok {
		if got := asString(config["model_reasoning_effort"]); got != "" {
			t.Fatalf("thread/resume reasoning effort = %q, want existing thread setting", got)
		}
	}
	if !adapter.CanResume(session) {
		t.Fatalf("CanResume = false, want true")
	}
}

func TestCodexAppServerAdapterResumeEmitsCommandSnapshot(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	var snapshots []AgentSessionCommandSnapshot
	adapter.SetCommandSnapshotSink(func(snapshot AgentSessionCommandSnapshot) {
		snapshots = append(snapshots, snapshot)
	})
	session := testAppServerSession()
	session.ProviderSessionID = "codex-thread-1"

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if len(snapshots) == 0 {
		t.Fatalf("Resume emitted no command snapshot; review/undo would be missing on resumed sessions")
	}
	names := agentSessionCommandNames(snapshots[len(snapshots)-1].Commands)
	for _, want := range []string{"review", "compact", "undo"} {
		if !containsString(names, want) {
			t.Fatalf("resume snapshot commands = %#v, want %q", names, want)
		}
	}
}

func TestCodexAppServerAdapterResumeRetainsReplayedContextUsage(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	transport.server.replayTokenUsageOnResume = true
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	session.ProviderSessionID = "codex-thread-1"

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}

	state := adapter.SessionState(session)
	usage, _ := state.RuntimeContext["usage"].(map[string]any)
	contextWindow, _ := usage["contextWindow"].(map[string]any)

	if contextWindow == nil {
		t.Fatalf("resume dropped replayed token usage: usage=%#v", usage)
	}
	if got, _ := int64Value(contextWindow["usedTokens"]); got != 20453 {
		t.Fatalf("usedTokens = %d, want 20453", got)
	}
	if got, _ := int64Value(contextWindow["totalTokens"]); got != 258400 {
		t.Fatalf("totalTokens = %d, want 258400", got)
	}
}

func TestCodexAppServerAdapterResumeRequiresProviderSession(t *testing.T) {
	t.Parallel()

	adapter := NewCodexAppServerAdapter(newScriptedAppServerTransport())
	session := testAppServerSession()
	session.ProviderSessionID = ""
	if err := adapter.Resume(context.Background(), session); err == nil {
		t.Fatalf("Resume without provider session id should fail")
	}
	if adapter.CanResume(session) {
		t.Fatalf("CanResume = true, want false")
	}
}

func TestCodexAppServerAdapterReleaseLiveSessionClosesClientAndKeepsProviderSession(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	session = applySessionEvents(session, events)
	if session.ProviderSessionID == "" {
		t.Fatalf("provider session id was not assigned")
	}
	if !adapter.HasLiveSession(session) {
		t.Fatalf("HasLiveSession = false, want true before release")
	}

	if err := adapter.ReleaseLiveSession(context.Background(), session); err != nil {
		t.Fatalf("ReleaseLiveSession: %v", err)
	}
	if adapter.HasLiveSession(session) {
		t.Fatalf("HasLiveSession = true, want false after release")
	}
	if session.ProviderSessionID != "codex-thread-1" {
		t.Fatalf("provider session id = %q, want preserved caller session", session.ProviderSessionID)
	}
	transport.conn.mu.Lock()
	closeCount := transport.conn.closeCount
	transport.conn.mu.Unlock()
	if closeCount == 0 {
		t.Fatalf("connection close count = 0, want client closed")
	}
}

func TestCodexAppServerAdapterDisconnectLiveSessionClosesClientAndKeepsProviderSession(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	session = applySessionEvents(session, events)
	providerSessionID := session.ProviderSessionID
	if err := adapter.DisconnectLiveSession(context.Background(), session); err != nil {
		t.Fatalf("DisconnectLiveSession: %v", err)
	}
	if adapter.HasLiveSession(session) {
		t.Fatal("HasLiveSession = true after disconnect")
	}
	if session.ProviderSessionID != providerSessionID || providerSessionID == "" {
		t.Fatalf("provider session id=%q, want preserved %q", session.ProviderSessionID, providerSessionID)
	}
	transport.conn.mu.Lock()
	closeCount := transport.conn.closeCount
	transport.conn.mu.Unlock()
	if closeCount == 0 {
		t.Fatal("connection was not closed")
	}
}

func TestCodexAppServerAdapterDisconnectLiveSessionRetriesCloseFailedHandle(t *testing.T) {
	t.Parallel()

	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	session := testAppServerSession()
	events, err := adapter.Start(context.Background(), session)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	session = applySessionEvents(session, events)
	transport.conn.mu.Lock()
	transport.conn.closeFailures = 1
	transport.conn.mu.Unlock()
	if err := adapter.DisconnectLiveSession(context.Background(), session); err == nil {
		t.Fatal("first DisconnectLiveSession error=nil, want close failure")
	}
	if adapter.getSession(session.AgentSessionID) == nil {
		t.Fatal("close-failed app-server handle lost ownership")
	}
	if err := adapter.DisconnectLiveSession(context.Background(), session); err != nil {
		t.Fatalf("retry DisconnectLiveSession: %v", err)
	}
	if adapter.getSession(session.AgentSessionID) != nil {
		t.Fatal("app-server handle remained after successful retry")
	}
	transport.conn.mu.Lock()
	closeCount := transport.conn.closeCount
	transport.conn.mu.Unlock()
	if closeCount != 2 {
		t.Fatalf("transport close calls=%d, want 2", closeCount)
	}
}

func TestCodexAppServerAdapterReleaseLiveSessionSkipsPendingRequests(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.commandApproval = true
	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "clean the build dir",
		}}, "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	waitForCondition(t, func() bool {
		return adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "approval-1") != nil
	})

	err := adapter.ReleaseLiveSession(context.Background(), session)
	if !errors.Is(err, ErrLiveSessionBusy) {
		t.Fatalf("ReleaseLiveSession error = %v, want ErrLiveSessionBusy", err)
	}
	if !adapter.HasLiveSession(session) {
		t.Fatalf("HasLiveSession = false, want pending request to keep live session")
	}
	if _, err := adapter.SubmitInteractive(context.Background(), session, SubmitInteractiveInput{
		TurnID:    "turn-local-1",
		RequestID: "approval-1",
		OptionID:  "deny",
	}); err != nil {
		t.Fatalf("SubmitInteractive after busy release: %v", err)
	}
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatal("exec did not finish after resolving pending approval")
	}
}

func TestCodexAppServerAdapterDisconnectLiveSessionSettlesPendingRequest(t *testing.T) {
	t.Parallel()

	adapter, transport, session := startedAppServerAdapter(t)
	transport.server.commandApproval = true
	execDone := make(chan struct{})
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "clean the build dir",
		}}, "", "turn-local-1", nil, nil)
		close(execDone)
	}()
	var pending *pendingInteractiveRequest
	waitForCondition(t, func() bool {
		pending = adapter.getPendingRequest(session.AgentSessionID, "turn-local-1", "approval-1")
		return pending != nil
	})

	if err := adapter.DisconnectLiveSession(context.Background(), session); err != nil {
		t.Fatalf("DisconnectLiveSession: %v", err)
	}
	select {
	case <-execDone:
	case <-time.After(5 * time.Second):
		t.Fatal("exec did not settle after workspace runtime disconnect")
	}
	if state := pending.disposition(); state != pendingInteractiveRequestStateInterrupted {
		t.Fatalf("pending request state=%q, want interrupted", state)
	}
	if adapter.HasLiveSession(session) {
		t.Fatal("HasLiveSession = true after pending request disconnect")
	}
}
