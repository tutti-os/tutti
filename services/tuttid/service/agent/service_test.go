package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agentsidecarservice "github.com/tutti-os/tutti/services/tuttid/service/agentsidecar"
)

func TestServiceCreatesAndListsSessions(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111",
		Provider:       "codex",
		Title:          stringRef("Migration smoke"),
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if session.ID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("session ID = %q, want frontend UUID", session.ID)
	}
	if session.Status != "running" {
		t.Fatalf("status = %q, want running", session.Status)
	}
	if !session.Resumable {
		t.Fatal("created session resumable = false, want true")
	}

	list, err := service.List(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("len(list) = %d, want 1", len(list))
	}
	if list[0].ID != session.ID {
		t.Fatalf("listed session ID = %q, want %q", list[0].ID, session.ID)
	}

	got, err := service.Get(context.Background(), "ws-1", session.ID)
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if got.ID != session.ID {
		t.Fatalf("got session ID = %q, want %q", got.ID, session.ID)
	}
}

func TestServiceCreateUsesRuntimePreparerResult(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		result: agentsidecarservice.PreparedRuntime{
			Cwd: "/prepared/workdir",
			Env: []string{"CODEX_HOME=/prepared/codex-home"},
		},
	}
	cwd := "/user/workdir"

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111",
		Cwd:            &cwd,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if session.Cwd != "/prepared/workdir" {
		t.Fatalf("session cwd = %q, want prepared cwd", session.Cwd)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	start := runtime.startCalls[0]
	if start.Cwd != "/prepared/workdir" {
		t.Fatalf("runtime cwd = %q, want prepared cwd", start.Cwd)
	}
	if len(start.Env) != 1 || start.Env[0] != "CODEX_HOME=/prepared/codex-home" {
		t.Fatalf("runtime env = %#v, want prepared env", start.Env)
	}
}

func TestServiceCreatePassesPlanModeToRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	planMode := true

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111",
		InitialContent: TextPromptContent("hello"),
		PlanMode:       &planMode,
		Provider:       "claude-code",
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if !runtime.startCalls[0].PlanMode {
		t.Fatal("runtime start plan mode = false, want true")
	}
	if session.Settings == nil || !session.Settings.PlanMode {
		t.Fatalf("session settings = %#v, want plan mode true", session.Settings)
	}
}

func TestServiceCreateClampsPlanModeForProvidersWithoutCapability(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	planMode := true

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "22222222-2222-4222-8222-222222222222",
		InitialContent: TextPromptContent("hello"),
		PlanMode:       &planMode,
		Provider:       "gemini",
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if runtime.startCalls[0].PlanMode {
		t.Fatal("runtime start plan mode = true, want clamped to false for gemini")
	}
	if session.Settings == nil || session.Settings.PlanMode {
		t.Fatalf("session settings = %#v, want plan mode clamped to false", session.Settings)
	}
}

func TestServiceCreateCleansPreparedRuntimeWhenStartFails(t *testing.T) {
	startErr := errors.New("start failed")
	runtime := newFakeRuntime()
	runtime.startErr = startErr
	service := NewService(runtime)
	cleanupCalls := make([]agentsidecarservice.CleanupInput, 0)
	service.RuntimePreparer = fakeRuntimePreparer{
		result:       agentsidecarservice.PreparedRuntime{Cwd: "/prepared/workdir"},
		cleanupCalls: &cleanupCalls,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		InitialContent: TextPromptContent("hello"),
		Provider:       "codex",
	})
	if !errors.Is(err, startErr) {
		t.Fatalf("Create error = %v, want %v", err, startErr)
	}
	if len(cleanupCalls) != 1 ||
		cleanupCalls[0].WorkspaceID != "ws-1" ||
		cleanupCalls[0].AgentSessionID != "session-1" {
		t.Fatalf("cleanup calls = %#v", cleanupCalls)
	}
}

func TestServiceCreateRejectsInvalidContentBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	prepareInput := (*agentsidecarservice.PrepareInput)(nil)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: prepareInput,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		InitialContent: []PromptContentBlock{{
			Type:     "image",
			MimeType: "image/png",
			Data:     "not-base64",
		}},
		Provider: "codex",
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Create error = %v, want ErrInvalidArgument", err)
	}
	if len(runtime.startCalls) != 0 {
		t.Fatalf("start calls = %d, want 0", len(runtime.startCalls))
	}
}

func TestServiceSendInputRejectsUnsupportedImageBeforePersistingAttachment(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.validateErr = ErrPromptImageUnsupported
	service := NewService(runtime)
	tempDir := t.TempDir()
	service.PromptAttachmentStore = PromptAttachmentStore{RootDir: tempDir}
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "ready",
		Visible:     true,
	}

	_, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{
		Content: []PromptContentBlock{{
			Type:     "image",
			MimeType: "image/png",
			Data:     "aGVsbG8=",
		}},
	})
	if !errors.Is(err, ErrPromptImageUnsupported) {
		t.Fatalf("SendInput error = %v, want ErrPromptImageUnsupported", err)
	}
	if len(runtime.execCalls) != 0 {
		t.Fatalf("exec calls = %d, want 0", len(runtime.execCalls))
	}
	if entries, err := os.ReadDir(filepath.Join(tempDir, "agent-session-attachments")); err == nil && len(entries) > 0 {
		t.Fatalf("attachment entries = %#v, want none", entries)
	}
}

func TestServiceCreateCleansPreparedRuntimeWhenInitialPromptFails(t *testing.T) {
	execErr := errors.New("exec failed")
	runtime := newFakeRuntime()
	runtime.execErr = execErr
	service := NewService(runtime)
	cleanupCalls := make([]agentsidecarservice.CleanupInput, 0)
	service.RuntimePreparer = fakeRuntimePreparer{
		result:       agentsidecarservice.PreparedRuntime{Cwd: "/prepared/workdir"},
		cleanupCalls: &cleanupCalls,
	}

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if !errors.Is(err, execErr) {
		t.Fatalf("Create error = %v, want %v", err, execErr)
	}
	if len(runtime.closeCalls) != 1 || runtime.closeCalls[0].AgentSessionID != "session-1" {
		t.Fatalf("close calls = %#v", runtime.closeCalls)
	}
	if len(cleanupCalls) != 1 ||
		cleanupCalls[0].WorkspaceID != "ws-1" ||
		cleanupCalls[0].AgentSessionID != "session-1" {
		t.Fatalf("cleanup calls = %#v", cleanupCalls)
	}
	if _, ok := runtime.Session("ws-1", "session-1"); ok {
		t.Fatal("runtime session still exists after failed initial prompt")
	}
}

func TestServiceCreatePassesInitialDisplayPromptToRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID:       "session-1",
		Provider:             "codex",
		InitialContent:       TextPromptContent("real automation prompt"),
		InitialDisplayPrompt: "Run Automation",
	})
	if err != nil {
		t.Fatalf("Create error = %v", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
	call := runtime.execCalls[0]
	if len(call.Content) != 1 || call.Content[0].Text != "real automation prompt" {
		t.Fatalf("runtime content = %#v", call.Content)
	}
	if call.DisplayPrompt != "Run Automation" {
		t.Fatalf("runtime display prompt = %q", call.DisplayPrompt)
	}
}

func TestServiceCreateDoesNotPassDerivedPromptToRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	_, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "session-1",
		Provider:       "codex",
		InitialContent: TextPromptContent("ordinary prompt"),
	})
	if err != nil {
		t.Fatalf("Create error = %v", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
	if runtime.execCalls[0].DisplayPrompt != "" {
		t.Fatalf("runtime display prompt = %q, want empty explicit display prompt", runtime.execCalls[0].DisplayPrompt)
	}
}

func TestServiceSendInputPassesDisplayPromptToRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Status:      "ready",
		Visible:     true,
	}

	_, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{
		Content:       TextPromptContent("real repair prompt"),
		DisplayPrompt: "Fix the app",
	})
	if err != nil {
		t.Fatalf("SendInput error = %v", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
	call := runtime.execCalls[0]
	if len(call.Content) != 1 || call.Content[0].Text != "real repair prompt" {
		t.Fatalf("runtime content = %#v", call.Content)
	}
	if call.DisplayPrompt != "Fix the app" {
		t.Fatalf("runtime display prompt = %q", call.DisplayPrompt)
	}
}

func TestServiceCreateGeneratesSessionIDBeforePreparingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput agentsidecarservice.PrepareInput
	service := NewService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: agentsidecarservice.PreparedRuntime{
			Cwd: "/prepared/workdir",
		},
	}
	cwd := "/user/workdir"

	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		Cwd:            &cwd,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if session.ID == "" {
		t.Fatal("session ID is empty, want generated ID")
	}
	if prepareInput.AgentSessionID != session.ID {
		t.Fatalf("prepare agentSessionID = %q, want %q", prepareInput.AgentSessionID, session.ID)
	}
	if len(runtime.startCalls) != 1 {
		t.Fatalf("start calls = %d, want 1", len(runtime.startCalls))
	}
	if runtime.startCalls[0].AgentSessionID != session.ID {
		t.Fatalf("runtime agentSessionID = %q, want %q", runtime.startCalls[0].AgentSessionID, session.ID)
	}
}

func TestServiceCreatePassesExtraSkillsToRuntimePreparer(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput agentsidecarservice.PrepareInput
	service := NewService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: agentsidecarservice.PreparedRuntime{
			Cwd: "/prepared/workdir",
		},
	}
	cwd := "/user/workdir"

	if _, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		Cwd:            &cwd,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
		ExtraSkills: []SessionSkillBundle{
			{
				Name: "app-factory",
				Files: map[string]string{
					"SKILL.md":                  "skill body",
					"references/contract.md":    "contract",
					"references/demos/demo.txt": "demo",
				},
			},
		},
	}); err != nil {
		t.Fatalf("Create returned error: %v", err)
	}
	if len(prepareInput.ExtraSkills) != 1 {
		t.Fatalf("prepare extra skills = %#v", prepareInput.ExtraSkills)
	}
	if prepareInput.ExtraSkills[0].Name != "app-factory" {
		t.Fatalf("prepare extra skill name = %q", prepareInput.ExtraSkills[0].Name)
	}
	if prepareInput.ExtraSkills[0].Files["references/contract.md"] != "contract" {
		t.Fatalf("prepare extra skill files = %#v", prepareInput.ExtraSkills[0].Files)
	}
}

func TestServiceDeleteCleansPreparedRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	cleanupCalls := make([]agentsidecarservice.CleanupInput, 0)
	service.RuntimePreparer = fakeRuntimePreparer{
		result:       agentsidecarservice.PreparedRuntime{Cwd: "/prepared/workdir"},
		cleanupCalls: &cleanupCalls,
	}
	cwd := "/user/workdir"
	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentSessionID: "11111111-1111-4111-8111-111111111111",
		Cwd:            &cwd,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}

	removed, err := service.Delete(context.Background(), "ws-1", session.ID)
	if err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if !removed {
		t.Fatal("Delete removed = false, want true")
	}
	if len(cleanupCalls) != 1 {
		t.Fatalf("cleanup calls = %d, want 1", len(cleanupCalls))
	}
	if cleanupCalls[0].WorkspaceID != "ws-1" || cleanupCalls[0].AgentSessionID != session.ID {
		t.Fatalf("cleanup call = %#v", cleanupCalls[0])
	}
}

func TestServiceGetsComposerOptionsWithoutStartingRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			Model:            " gpt-5 ",
			PermissionModeID: " auto ",
			ReasoningEffort:  " high ",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %d, want no started sessions", len(runtime.sessions))
	}
	if options.Provider != "codex" {
		t.Fatalf("provider = %q, want codex", options.Provider)
	}
	if options.EffectiveSettings.Model != "gpt-5" || options.EffectiveSettings.PermissionModeID != "auto" || options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings = %#v", options.EffectiveSettings)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if len(configOptions) != 2 {
		t.Fatalf("len(configOptions) = %d, want 2", len(configOptions))
	}
	if configOptions[0]["id"] != "model" || configOptions[0]["currentValue"] != "gpt-5" {
		t.Fatalf("model option = %#v", configOptions[0])
	}
	if configOptions[1]["id"] != "reasoning_effort" || configOptions[1]["currentValue"] != "high" {
		t.Fatalf("reasoning option = %#v", configOptions[1])
	}
	if options.ModelConfig.CurrentValue != "gpt-5" || len(options.ModelConfig.Options) != 1 {
		t.Fatalf("modelConfig = %#v", options.ModelConfig)
	}
	if options.ReasoningConfig.CurrentValue != "high" || len(options.ReasoningConfig.Options) == 0 {
		t.Fatalf("reasoningConfig = %#v", options.ReasoningConfig)
	}
	if options.PermissionConfig.DefaultValue != "auto" || len(options.PermissionConfig.Modes) != 3 {
		t.Fatalf("permissionConfig = %#v", options.PermissionConfig)
	}
	if options.PermissionConfig.Modes[1].Label != "Approve for me" {
		t.Fatalf("permission label = %#v, want Approve for me", options.PermissionConfig.Modes[1])
	}
	capabilities, ok := options.RuntimeContext["capabilities"].([]string)
	if !ok || !slices.Contains(capabilities, "imageInput") {
		t.Fatalf("capabilities = %#v, want imageInput", options.RuntimeContext["capabilities"])
	}
}

func TestServiceGetsComposerOptionsLocalizesDisplayLabels(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Locale:   "zh-CN",
		Provider: "claude-code",
		Settings: ComposerSettings{
			PermissionModeID: "dontAsk",
			ReasoningEffort:  "xhigh",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.ReasoningConfig.Options[len(options.ReasoningConfig.Options)-1].Label != "超高" {
		t.Fatalf("reasoningConfig = %#v, want zh-CN xhigh label", options.ReasoningConfig)
	}
	var dontAsk PermissionModeOption
	for _, mode := range options.PermissionConfig.Modes {
		if mode.ID == "dontAsk" {
			dontAsk = mode
		}
	}
	if dontAsk.Label != "不再询问" || dontAsk.Description == "" {
		t.Fatalf("dontAsk = %#v, want localized label and description", dontAsk)
	}
	capabilities, ok := options.RuntimeContext["capabilities"].([]string)
	if !ok || !slices.Contains(capabilities, "imageInput") {
		t.Fatalf("capabilities = %#v, want imageInput", options.RuntimeContext["capabilities"])
	}
}

func TestServiceGetsComposerOptionsFromCodexModelCatalog(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{ID: "gpt-5", DisplayName: "GPT-5"},
				{ID: "gpt-5.1", DisplayName: "GPT-5.1"},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			Model:           "gpt-5.2-custom",
			ReasoningEffort: "medium",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	modelOptions, ok := configOptions[0]["options"].([]map[string]string)
	if !ok {
		t.Fatalf("model options = %#v", configOptions[0]["options"])
	}
	if len(modelOptions) != 3 {
		t.Fatalf("len(modelOptions) = %d, want catalog models plus selected custom model", len(modelOptions))
	}
	if modelOptions[0]["value"] != "gpt-5" || modelOptions[1]["value"] != "gpt-5.1" || modelOptions[2]["value"] != "gpt-5.2-custom" {
		t.Fatalf("modelOptions = %#v", modelOptions)
	}
	if options.RuntimeContext["modelCatalogSource"] != "codex-cli" {
		t.Fatalf("modelCatalogSource = %#v, want codex-cli", options.RuntimeContext["modelCatalogSource"])
	}
	if len(runtime.sessions) != 0 {
		t.Fatalf("runtime sessions = %d, want no started sessions", len(runtime.sessions))
	}
}

func TestServiceGetsComposerOptionsWithResolvedCodexDefaultModel(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "codex",
			Source:   "codex-cli",
			Models: []AgentModelOption{
				{ID: "gpt-5.5", DisplayName: "GPT-5.5", IsDefault: true},
				{ID: "gpt-5.4", DisplayName: "GPT-5.4"},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "gpt-5.5" {
		t.Fatalf("effectiveSettings.model = %q, want gpt-5.5", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	if configOptions[0]["currentValue"] != "gpt-5.5" {
		t.Fatalf("model option = %#v", configOptions[0])
	}
	if len(configOptions) < 2 || configOptions[1]["currentValue"] != "high" {
		t.Fatalf("reasoning option = %#v", configOptions)
	}
}

func TestServiceGetsComposerOptionsNormalizesCodexMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "codex",
		Settings: ComposerSettings{
			ReasoningEffort: "minimal",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) < 2 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	reasoningOptions, ok := configOptions[1]["options"].([]map[string]string)
	if !ok {
		t.Fatalf("reasoning options = %#v", configOptions[1]["options"])
	}
	for _, option := range reasoningOptions {
		if option["value"] == "minimal" {
			t.Fatalf("reasoning options = %#v, want codex minimal filtered out", reasoningOptions)
		}
	}
}

func TestServiceGetsComposerOptionsNormalizesClaudeMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "claude-code",
		Settings: ComposerSettings{
			ReasoningEffort: "minimal",
		},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
	configOptions, ok := options.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) < 2 {
		t.Fatalf("configOptions = %#v", options.RuntimeContext["configOptions"])
	}
	reasoningOptions, ok := configOptions[1]["options"].([]map[string]string)
	if !ok {
		t.Fatalf("reasoning options = %#v", configOptions[1]["options"])
	}
	for _, option := range reasoningOptions {
		if option["value"] == "minimal" {
			t.Fatalf("reasoning options = %#v, want claude minimal filtered out", reasoningOptions)
		}
	}
}

func TestServiceGetsComposerOptionsWithResolvedClaudeDefaultModel(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.ModelCatalog = fakeModelCatalog{
		result: AgentModelCatalogResult{
			Provider: "claude-code",
			Source:   "claude-static",
			Models: []AgentModelOption{
				{ID: "sonnet", DisplayName: "sonnet"},
				{ID: "opus", DisplayName: "opus", IsDefault: true},
			},
		},
	}

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "claude-code",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "opus" {
		t.Fatalf("effectiveSettings.model = %q, want opus", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "high" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want high", options.EffectiveSettings.ReasoningEffort)
	}
}

func TestServiceGetsComposerOptionsLeavesUnresolvedProviderModelUnset(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)

	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "openclaw",
	})
	if err != nil {
		t.Fatalf("GetComposerOptions returned error: %v", err)
	}
	if options.EffectiveSettings.Model != "" {
		t.Fatalf("effectiveSettings.model = %q, want empty", options.EffectiveSettings.Model)
	}
	if options.EffectiveSettings.ReasoningEffort != "" {
		t.Fatalf("effectiveSettings.reasoningEffort = %q, want empty", options.EffectiveSettings.ReasoningEffort)
	}
	if capabilities, ok := options.RuntimeContext["capabilities"].([]string); ok &&
		slices.Contains(capabilities, "imageInput") {
		t.Fatalf("capabilities = %#v, want no imageInput", options.RuntimeContext["capabilities"])
	}
}

func TestServiceUpdateSettingsNormalizesCodexMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		Provider:    "codex",
		WorkspaceID: "ws-1",
		Status:      "working",
		Settings: &ComposerSettings{
			ReasoningEffort: "high",
		},
	}
	service := NewService(runtime)
	reasoningEffort := "minimal"

	session, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
		ReasoningEffort: &reasoningEffort,
	})
	if err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	if session.Settings == nil || session.Settings.ReasoningEffort != "high" {
		t.Fatalf("session settings = %#v, want reasoningEffort high", session.Settings)
	}
}

func TestServiceUpdateSettingsNormalizesClaudeMinimalReasoningEffort(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:          "session-1",
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Status:      "working",
		Settings: &ComposerSettings{
			ReasoningEffort: "high",
		},
	}
	service := NewService(runtime)
	reasoningEffort := "minimal"

	session, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
		ReasoningEffort: &reasoningEffort,
	})
	if err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	if session.Settings == nil || session.Settings.ReasoningEffort != "high" {
		t.Fatalf("session settings = %#v, want reasoningEffort high", session.Settings)
	}
}

func TestServiceMapsRuntimeSessionLastError(t *testing.T) {
	now := time.Now().UnixMilli()
	session := serviceSession(RuntimeSession{
		ID:              "session-1",
		Provider:        "codex",
		Status:          "failed",
		Title:           "Smoke",
		LastError:       "codex-acp: executable file not found",
		WorkspaceID:     "ws-1",
		CreatedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}, true)

	if session.LastError == nil || *session.LastError != "codex-acp: executable file not found" {
		t.Fatalf("last error = %#v, want runtime failure detail", session.LastError)
	}
}

func TestServiceSessionNormalizesReasoningRuntimeConfigOptions(t *testing.T) {
	session := serviceSession(RuntimeSession{
		ID:          "session-1",
		Provider:    "claude-code",
		WorkspaceID: "ws-1",
		Status:      "working",
		Settings: &ComposerSettings{
			ReasoningEffort: "low",
		},
		RuntimeContext: map[string]any{
			"configOptions": []any{
				map[string]any{
					"id":           "effort",
					"currentValue": "low",
					"options": []any{
						map[string]any{"name": "Default", "value": "default"},
						map[string]any{"name": "Low", "value": "low"},
						map[string]any{"name": "Medium", "value": "medium"},
						map[string]any{"name": "High", "value": "high"},
						map[string]any{"name": "Max", "value": "max"},
					},
				},
			},
			"reasoningEffort": "low",
		},
	}, true)

	configOptions, ok := session.RuntimeContext["configOptions"].([]any)
	if !ok || len(configOptions) != 1 {
		t.Fatalf("configOptions = %#v", session.RuntimeContext["configOptions"])
	}
	option, ok := configOptions[0].(map[string]any)
	if !ok {
		t.Fatalf("option = %#v", configOptions[0])
	}
	if option["currentValue"] != "low" {
		t.Fatalf("currentValue = %#v, want low", option["currentValue"])
	}
	options, ok := option["options"].([]map[string]string)
	if !ok {
		t.Fatalf("options = %#v", option["options"])
	}
	values := make([]string, 0, len(options))
	for _, entry := range options {
		values = append(values, entry["value"])
	}
	if strings.Join(values, ",") != "low,medium,high,xhigh" {
		t.Fatalf("values = %#v, want [low medium high xhigh]", values)
	}
}

func TestActivityProjectionMapsLifecycleAndPhaseToServiceStatus(t *testing.T) {
	tests := []struct {
		name    string
		session agentactivitybiz.Session
		want    string
	}{
		{
			name:    "active working phase",
			session: agentactivitybiz.Session{Status: "active", CurrentPhase: "working"},
			want:    "working",
		},
		{
			name:    "active waiting input phase",
			session: agentactivitybiz.Session{Status: "active", CurrentPhase: "waiting_input"},
			want:    "waiting",
		},
		{
			name:    "completed lifecycle wins",
			session: agentactivitybiz.Session{Status: "completed", CurrentPhase: "working"},
			want:    "completed",
		},
		{
			name:    "failed lifecycle wins",
			session: agentactivitybiz.Session{Status: "failed", CurrentPhase: "idle"},
			want:    "failed",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := agentActivitySessionStatus(tt.session); got != tt.want {
				t.Fatalf("agentActivitySessionStatus() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestActivityProjectionPublishesSessionUpdateForUnappliedStatePatch(t *testing.T) {
	repo := &activityProjectionRepoStub{
		stateResult: agentactivitybiz.StateReportResult{
			Accepted:        true,
			StateApplied:    false,
			LastEventUnixMS: 200,
			Session: agentactivitybiz.Session{
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				Status:          "completed",
				CurrentPhase:    "idle",
				LastEventUnixMS: 200,
			},
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)

	reply, err := projection.ReportSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			LifecycleStatus:  "active",
			CurrentPhase:     "working",
			OccurredAtUnixMS: 150,
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if !reply.Accepted || reply.StateApplied {
		t.Fatalf("reply = %#v, want accepted unapplied state", reply)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("published events = %d, want 1", len(publisher.events))
	}
	event := publisher.events[0]
	if event.eventType != "session_update" {
		t.Fatalf("published event type = %q, want session_update", event.eventType)
	}
	if got := event.payload["eventType"]; got != "session_update" {
		t.Fatalf("payload eventType = %#v, want session_update", got)
	}
	if got := event.payload["lastEventUnixMs"]; got != int64(200) {
		t.Fatalf("payload lastEventUnixMs = %#v, want 200", got)
	}
	if _, ok := event.payload["lifecycleStatus"]; ok {
		t.Fatalf("payload contains stale lifecycleStatus: %#v", event.payload)
	}
}

func TestActivityProjectionUsesRuntimeContextTitleFallback(t *testing.T) {
	repo := &activityProjectionRepoStub{
		stateResult: agentactivitybiz.StateReportResult{
			Accepted:        true,
			StateApplied:    true,
			LastEventUnixMS: 200,
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)

	_, err := projection.ReportSessionState(context.Background(), agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			RuntimeContext: map[string]any{
				"title": "Automation Review",
			},
			LifecycleStatus:  "failed",
			CurrentPhase:     "failed",
			OccurredAtUnixMS: 150,
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if got := repo.stateInput.Title; got != "Automation Review" {
		t.Fatalf("reported title = %q, want runtime context title", got)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("published events = %d, want 1", len(publisher.events))
	}
	if got := publisher.events[0].payload["title"]; got != "Automation Review" {
		t.Fatalf("published title = %#v, want runtime context title", got)
	}
}

func TestActivityProjectionPublishesCanonicalSessionIDForMessageUpdates(t *testing.T) {
	repo := &activityProjectionRepoStub{
		messageResult: agentactivitybiz.MessageReportResult{
			AcceptedCount: 1,
			LatestVersion: 1,
			Messages: []agentactivitybiz.Message{{
				AgentSessionID: "session-1",
				MessageID:      "message-1",
				Version:        1,
				Role:           "assistant",
				Kind:           "text",
				Status:         "completed",
				Payload:        map[string]any{"text": "hello"},
			}},
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)

	reply, err := projection.ReportSessionMessages(context.Background(), agentsessionstore.ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "provider-session-1",
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Source: agentsessionstore.EventSource{
			Provider:          "codex",
			ProviderSessionID: "provider-session-1",
		},
		Updates: []agentsessionstore.WorkspaceAgentSessionMessageUpdate{{
			MessageID: "message-1",
			Role:      "assistant",
			Kind:      "text",
			Status:    "completed",
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if reply.AcceptedCount != 1 {
		t.Fatalf("reply = %#v, want accepted message", reply)
	}
	if repo.messageInput.Provider != "codex" {
		t.Fatalf("repo message provider = %q, want codex", repo.messageInput.Provider)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("published events = %d, want 1", len(publisher.events))
	}
	event := publisher.events[0]
	if event.agentSessionID != "session-1" {
		t.Fatalf("published agentSessionID = %q, want session-1", event.agentSessionID)
	}
	if event.payload["agentSessionId"] != "session-1" {
		t.Fatalf("payload agentSessionId = %#v, want session-1", event.payload["agentSessionId"])
	}
}

func TestStaleResumeMessageUpdatesFailOpenToolCallsForLatestTurn(t *testing.T) {
	updates := staleResumeMessageUpdates([]SessionMessage{
		{
			MessageID: "approval-2",
			TurnID:    "turn-2",
			Role:      "assistant",
			Kind:      "tool_call",
			Status:    "waiting_approval",
			Payload: map[string]any{
				"input":  map[string]any{"requestId": "permission-2"},
				"status": "waiting_approval",
			},
		},
		{
			MessageID: "approval-1",
			TurnID:    "turn-1",
			Role:      "assistant",
			Kind:      "tool_call",
			Status:    "waiting_approval",
			Payload:   map[string]any{"status": "waiting_approval"},
		},
	}, 1234)

	if len(updates) != 1 {
		t.Fatalf("updates = %#v, want latest turn open tool call", updates)
	}
	update := updates[0]
	if update.MessageID != "approval-2" || update.TurnID != "turn-2" || update.Status != "failed" {
		t.Fatalf("update = %#v, want failed latest approval", update)
	}
	if update.CompletedAtUnixMS != 1234 {
		t.Fatalf("completed at = %d, want 1234", update.CompletedAtUnixMS)
	}
	errorPayload, ok := update.Payload["error"].(map[string]any)
	if !ok || errorPayload["requestId"] != "permission-2" {
		t.Fatalf("error payload = %#v, want permission request id", update.Payload["error"])
	}
}

func TestServiceListsSessionMessages(t *testing.T) {
	service := NewService(newFakeRuntime())
	lastLimit := 0
	service.MessageReader = fakeMessageReader{
		lastLimit: &lastLimit,
		page: SessionMessagesPage{
			AgentSessionID: "session-1",
			Messages: []SessionMessage{
				{
					AgentSessionID: "session-1",
					MessageID:      "msg-1",
					Payload:        map[string]any{"content": "done"},
					Version:        3,
				},
			},
			LatestVersion: 3,
			HasMore:       false,
		},
	}

	page, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"session-1",
		ListMessagesInput{AfterVersion: 1, Limit: 20},
	)
	if err != nil {
		t.Fatalf("ListMessages returned error: %v", err)
	}
	if page.AgentSessionID != "session-1" {
		t.Fatalf("agent session id = %q, want session-1", page.AgentSessionID)
	}
	if len(page.Messages) != 1 {
		t.Fatalf("len(page.Messages) = %d, want 1", len(page.Messages))
	}
	page.Messages[0].Payload["content"] = "mutated"
	nextPage, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"session-1",
		ListMessagesInput{},
	)
	if err != nil {
		t.Fatalf("ListMessages second read returned error: %v", err)
	}
	if got := nextPage.Messages[0].Payload["content"]; got != "done" {
		t.Fatalf("payload content = %#v, want done", got)
	}
	if lastLimit != defaultListMessagesLimit {
		t.Fatalf("default limit = %d, want %d", lastLimit, defaultListMessagesLimit)
	}
}

func TestServiceListMessagesReturnsEmptyPageForLiveSessionWithoutProjection(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:live-session"] = RuntimeSession{
		ID:          "live-session",
		WorkspaceID: "ws-1",
		Provider:    "codex",
	}
	service := NewService(runtime)

	page, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"live-session",
		ListMessagesInput{AfterVersion: 7, Limit: 20},
	)
	if err != nil {
		t.Fatalf("ListMessages returned error: %v", err)
	}
	if page.AgentSessionID != "live-session" {
		t.Fatalf("agent session id = %q, want live-session", page.AgentSessionID)
	}
	if len(page.Messages) != 0 || page.LatestVersion != 7 || page.HasMore {
		t.Fatalf("page = %#v, want empty page preserving after version", page)
	}
}

func TestServiceListMessagesReturnsEmptyPageForPersistedSessionWithoutProjectionMessages(t *testing.T) {
	service := NewService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:persisted-session": {
				ID:          "persisted-session",
				WorkspaceID: "ws-1",
				Provider:    "codex",
			},
		},
	}
	service.MessageReader = fakeMessageReader{}

	page, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"persisted-session",
		ListMessagesInput{Order: agentactivitybiz.MessageOrderDesc, Limit: 20},
	)
	if err != nil {
		t.Fatalf("ListMessages returned error: %v", err)
	}
	if page.AgentSessionID != "persisted-session" {
		t.Fatalf("agent session id = %q, want persisted-session", page.AgentSessionID)
	}
	if len(page.Messages) != 0 || page.LatestVersion != 0 || page.HasMore {
		t.Fatalf("page = %#v, want empty desc page", page)
	}
}

func TestServiceListMessagesReturnsNotFoundForUnknownSession(t *testing.T) {
	service := NewService(newFakeRuntime())
	service.MessageReader = fakeMessageReader{}

	if _, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"missing-session",
		ListMessagesInput{},
	); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("ListMessages error = %v, want ErrSessionNotFound", err)
	}
}

func TestServiceFallsBackToPersistedSessions(t *testing.T) {
	service := NewService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "working",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	list, err := service.List(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	if len(list) != 1 || list[0].ID != "session-1" {
		t.Fatalf("persisted list = %#v", list)
	}

	got, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if got.ID != "session-1" {
		t.Fatalf("persisted get id = %q", got.ID)
	}
	if !got.Resumable {
		t.Fatal("persisted session resumable = false, want true")
	}
}

func TestServiceListFilteredMatchesSearchVisibilityLimitAndUpdatedOrder(t *testing.T) {
	runtime := newFakeRuntime()
	olderUpdatedAt := time.UnixMilli(2000)
	newerUpdatedAt := time.UnixMilli(4000)
	hiddenUpdatedAt := time.UnixMilli(5000)
	runtime.sessions["ws-1:session-hidden"] = RuntimeSession{
		ID:              "session-hidden",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Cwd:             "/workspace/hidden",
		Status:          "completed",
		Visible:         false,
		Title:           "Mention hidden",
		CreatedAtUnixMS: time.UnixMilli(1000).UnixMilli(),
		UpdatedAtUnixMS: hiddenUpdatedAt.UnixMilli(),
	}
	runtime.sessions["ws-1:session-older"] = RuntimeSession{
		ID:              "session-older",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Cwd:             "/workspace/older",
		Status:          "completed",
		Visible:         true,
		Title:           "Mention older",
		CreatedAtUnixMS: time.UnixMilli(1000).UnixMilli(),
		UpdatedAtUnixMS: olderUpdatedAt.UnixMilli(),
	}
	runtime.sessions["ws-1:session-newer"] = RuntimeSession{
		ID:              "session-newer",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Cwd:             "/workspace/newer",
		Status:          "working",
		Visible:         true,
		Title:           "Mention newer",
		CreatedAtUnixMS: time.UnixMilli(1000).UnixMilli(),
		UpdatedAtUnixMS: newerUpdatedAt.UnixMilli(),
	}

	service := NewService(runtime)
	list, err := service.ListFiltered(context.Background(), "ws-1", ListSessionsInput{
		SearchQuery: "mention",
		Limit:       1,
		VisibleOnly: true,
	})
	if err != nil {
		t.Fatalf("ListFiltered returned error: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("len(list) = %d, want 1", len(list))
	}
	if list[0].ID != "session-newer" {
		t.Fatalf("list[0].ID = %q, want session-newer", list[0].ID)
	}
}

func TestServiceListsActivePeersFromCanonicalSessionStatus(t *testing.T) {
	service := NewService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				Provider:        "codex",
				Status:          "working",
				Title:           "Active work",
				CreatedAtUnixMS: 1000,
				UpdatedAtUnixMS: 2000,
			},
			"ws-1:session-2": {
				ID:              "session-2",
				WorkspaceID:     "ws-1",
				Provider:        "claude",
				Status:          "completed",
				Title:           "Done",
				CreatedAtUnixMS: 2000,
				UpdatedAtUnixMS: 3000,
			},
		},
	}

	peers, err := service.ListActivePeers(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("ListActivePeers returned error: %v", err)
	}
	if len(peers.Agents) != 1 || peers.Agents[0].Session.ID != "session-1" {
		t.Fatalf("peers = %#v", peers)
	}
	if peers.Agents[0].SelfRelation != "unknown" {
		t.Fatalf("self relation = %q", peers.Agents[0].SelfRelation)
	}
	if peers.SelfKnown || !peers.MayIncludeSelf || peers.Warning != "SELF_IDENTITY_UNAVAILABLE" {
		t.Fatalf("peer identity metadata = %#v", peers)
	}
}

func TestServiceDeletesPersistedSession(t *testing.T) {
	service := NewService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "codex",
			},
		},
	}

	removed, err := service.Delete(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if !removed {
		t.Fatal("Delete removed = false, want true")
	}
	if _, err := service.Get(context.Background(), "ws-1", "session-1"); err != ErrSessionNotFound {
		t.Fatalf("Get after delete error = %v, want %v", err, ErrSessionNotFound)
	}
}

func TestServiceDeleteClosesRuntimeSession(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}

	removed, err := service.Delete(context.Background(), "ws-1", session.ID)
	if err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if !removed {
		t.Fatal("Delete removed = false, want true")
	}
	if len(runtime.closeCalls) != 1 || runtime.closeCalls[0].AgentSessionID != session.ID {
		t.Fatalf("close calls = %#v", runtime.closeCalls)
	}
}

func TestServiceResumesPersistedSessionBeforeInput(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "working",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	session, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{Content: TextPromptContent("hello")})
	if err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	if session.ID != "session-1" {
		t.Fatalf("session id = %q", session.ID)
	}
	if len(runtime.resumeCalls) != 1 {
		t.Fatalf("resume calls = %d, want 1", len(runtime.resumeCalls))
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls = %d, want 1", len(runtime.execCalls))
	}
}

func TestServiceSendInputReturnsRuntimeExecStatusOverStalePersistedStatus(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "completed",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	session, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{Content: TextPromptContent("hello")})
	if err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	if session.Status != "running" {
		t.Fatalf("session status = %q, want running", session.Status)
	}
	if session.EndedAt != nil {
		t.Fatalf("endedAt = %#v, want nil for accepted input", session.EndedAt)
	}
}

func TestServiceReconcilesStalePersistedTurnBeforeSubmittingInteractive(t *testing.T) {
	runtime := newFakeRuntime()
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Cwd:               "/workspace",
				Status:            "waiting",
				Title:             "Waiting",
			},
		},
	}

	session, err := service.SubmitInteractive(
		context.Background(),
		"ws-1",
		"session-1",
		"permission-1",
		SubmitInteractiveInput{OptionID: stringRef("approve")},
	)
	if err != nil {
		t.Fatalf("SubmitInteractive returned error: %v", err)
	}
	if session.ID != "session-1" {
		t.Fatalf("session ID = %q, want session-1", session.ID)
	}
	if len(reconciled) != 1 || reconciled[0].ID != "session-1" {
		t.Fatalf("reconciled = %#v, want stale persisted session", reconciled)
	}
	if len(runtime.submitInteractiveCalls) != 0 {
		t.Fatalf("submit interactive calls = %#v, want skipped stale live request", runtime.submitInteractiveCalls)
	}
}

func TestServiceReconcilesStalePersistedTurnWhenRuntimeSessionIsReady(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:                "session-1",
		WorkspaceID:       "ws-1",
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		Status:            "ready",
	}
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "waiting",
			},
		},
	}

	if _, err := service.SubmitInteractive(
		context.Background(),
		"ws-1",
		"session-1",
		"permission-1",
		SubmitInteractiveInput{OptionID: stringRef("approve")},
	); err != nil {
		t.Fatalf("SubmitInteractive returned error: %v", err)
	}
	if len(reconciled) != 1 {
		t.Fatalf("reconciled = %#v, want stale ready runtime session reconciled", reconciled)
	}
	if len(runtime.submitInteractiveCalls) != 0 {
		t.Fatalf("submit interactive calls = %#v, want skipped stale live request", runtime.submitInteractiveCalls)
	}
}

func TestServiceDoesNotReconcileStalePersistedTurnWhenRuntimeSessionIsWorking(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:                "session-1",
		WorkspaceID:       "ws-1",
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		Status:            "working",
	}
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "waiting",
			},
		},
	}

	if _, err := service.SubmitInteractive(
		context.Background(),
		"ws-1",
		"session-1",
		"permission-1",
		SubmitInteractiveInput{OptionID: stringRef("approve")},
	); err != nil {
		t.Fatalf("SubmitInteractive returned error: %v", err)
	}
	if len(reconciled) != 0 {
		t.Fatalf("reconciled = %#v, want live working runtime session left alone", reconciled)
	}
	if len(runtime.submitInteractiveCalls) != 1 {
		t.Fatalf("submit interactive calls = %#v, want live runtime interactive response", runtime.submitInteractiveCalls)
	}
}

func TestServiceGetReconcilesStalePersistedTurn(t *testing.T) {
	runtime := newFakeRuntime()
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "waiting",
			},
		},
	}

	session, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if len(reconciled) != 1 {
		t.Fatalf("reconciled = %#v, want stale persisted session reconciled on get", reconciled)
	}
	if session.Status == "waiting" {
		t.Fatalf("session status = %q, want stale waiting cleared", session.Status)
	}
}

func TestServiceReconcilesStalePersistedTurnBeforeCanceling(t *testing.T) {
	runtime := newFakeRuntime()
	reconciled := make([]PersistedSession, 0)
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		reconciled: &reconciled,
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Status:            "working",
			},
		},
	}

	result, err := service.Cancel(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Cancel returned error: %v", err)
	}
	if result.Canceled || result.Reason != CancelReasonStaleTurnReconciled {
		t.Fatalf("cancel result = %#v, want stale turn reconciled without cancel", result)
	}
	if len(reconciled) != 1 || reconciled[0].ID != "session-1" {
		t.Fatalf("reconciled = %#v, want stale persisted session", reconciled)
	}
	if len(runtime.cancelCalls) != 0 {
		t.Fatalf("cancel calls = %#v, want skipped stale runtime cancel", runtime.cancelCalls)
	}
}

func TestServiceCancelReportsActiveTurnCanceled(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:              "session-1",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Status:          "working",
		CreatedAtUnixMS: 100,
		UpdatedAtUnixMS: 200,
	}
	service := NewService(runtime)

	result, err := service.Cancel(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Cancel returned error: %v", err)
	}
	if !result.Canceled || result.Reason != CancelReasonActiveTurnCanceled {
		t.Fatalf("cancel result = %#v, want active turn canceled", result)
	}
	if result.Session.ID != "session-1" || result.Session.Status != "running" {
		t.Fatalf("session = %#v, want running session-1", result.Session)
	}
}

func TestServiceCancelReportsNoActiveTurn(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.cancelResult = RuntimeCancelResult{AgentSessionID: "session-1", Canceled: false}
	runtime.cancelResultSet = true
	runtime.sessions["ws-1:session-1"] = RuntimeSession{
		ID:              "session-1",
		WorkspaceID:     "ws-1",
		Provider:        "codex",
		Status:          "ready",
		CreatedAtUnixMS: 100,
		UpdatedAtUnixMS: 200,
	}
	service := NewService(runtime)

	result, err := service.Cancel(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Cancel returned error: %v", err)
	}
	if result.Canceled || result.Reason != CancelReasonNoActiveTurn {
		t.Fatalf("cancel result = %#v, want no active turn", result)
	}
	if result.Session.ID != "session-1" || result.Session.Status != "created" {
		t.Fatalf("session = %#v, want created session-1", result.Session)
	}
}

func TestServiceResumesPersistedSessionWithPreparedRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	var prepareInput agentsidecarservice.PrepareInput
	service := NewService(runtime)
	service.RuntimePreparer = fakeRuntimePreparer{
		input: &prepareInput,
		result: agentsidecarservice.PreparedRuntime{
			Cwd: "/prepared/workdir",
			Env: []string{"CODEX_HOME=/prepared/codex-home"},
		},
	}
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				ProviderSessionID: "provider-session-1",
				Cwd:               "/persisted/workdir",
				Settings: ComposerSettings{
					Model:            "gpt-5",
					PermissionModeID: "auto",
					ReasoningEffort:  "high",
				},
				Status:          "working",
				Title:           "Persisted session",
				CreatedAtUnixMS: 1000,
				UpdatedAtUnixMS: 2000,
			},
		},
	}

	if _, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{Content: TextPromptContent("hello")}); err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	if prepareInput.WorkspaceID != "ws-1" ||
		prepareInput.AgentSessionID != "session-1" ||
		prepareInput.Provider != "codex" ||
		prepareInput.Cwd != "/persisted/workdir" ||
		prepareInput.Model != "gpt-5" ||
		prepareInput.PermissionModeID != "auto" ||
		prepareInput.ReasoningEffort != "high" {
		t.Fatalf("prepare input = %#v, want persisted session metadata", prepareInput)
	}
	if len(runtime.resumeCalls) != 1 {
		t.Fatalf("resume calls = %d, want 1", len(runtime.resumeCalls))
	}
	resume := runtime.resumeCalls[0]
	if resume.Cwd != "/prepared/workdir" {
		t.Fatalf("resume cwd = %q, want prepared cwd", resume.Cwd)
	}
	if len(resume.Env) != 1 || resume.Env[0] != "CODEX_HOME=/prepared/codex-home" {
		t.Fatalf("resume env = %#v, want prepared env", resume.Env)
	}
	if resume.Settings.Model != "gpt-5" ||
		resume.Settings.PermissionModeID != "auto" ||
		resume.Settings.ReasoningEffort != "high" {
		t.Fatalf("resume settings = %#v, want persisted settings", resume.Settings)
	}
}

func TestServiceResumesPersistedSessionWithoutProviderSessionID(t *testing.T) {
	runtime := newFakeRuntime()
	service := NewService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				Provider:        "codex",
				Status:          "working",
				Title:           "Persisted session",
				CreatedAtUnixMS: 1000,
				UpdatedAtUnixMS: 2000,
			},
		},
	}

	if _, err := service.SendInput(
		context.Background(),
		"ws-1",
		"session-1",
		SendInput{Content: TextPromptContent("hello")},
	); err != nil {
		t.Fatalf("SendInput returned error: %v", err)
	}
	if len(runtime.resumeCalls) != 1 {
		t.Fatalf("resume calls = %d, want 1", len(runtime.resumeCalls))
	}
	if runtime.resumeCalls[0].ProviderSessionID != "" {
		t.Fatalf("provider session id = %q, want empty", runtime.resumeCalls[0].ProviderSessionID)
	}
}

func TestServiceListMessagesValidatesInputs(t *testing.T) {
	service := NewService(newFakeRuntime())

	if _, err := service.ListMessages(
		context.Background(),
		"",
		"session-1",
		ListMessagesInput{},
	); err != ErrInvalidArgument {
		t.Fatalf("workspace validation error = %v, want %v", err, ErrInvalidArgument)
	}
	if _, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"",
		ListMessagesInput{},
	); err != ErrInvalidArgument {
		t.Fatalf("session validation error = %v, want %v", err, ErrInvalidArgument)
	}
	if _, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"session-1",
		ListMessagesInput{Limit: -1},
	); err != ErrInvalidArgument {
		t.Fatalf("limit validation error = %v, want %v", err, ErrInvalidArgument)
	}
}

type fakeRuntime struct {
	nextID                 int
	cancelCalls            []RuntimeCancelInput
	cancelResult           RuntimeCancelResult
	cancelResultSet        bool
	closeErr               error
	closeCalls             []RuntimeCloseInput
	execErr                error
	execCalls              []RuntimeExecInput
	resumeCalls            []RuntimeResumeInput
	sessions               map[string]RuntimeSession
	submitInteractiveCalls []RuntimeSubmitInteractiveInput
	startErr               error
	startCalls             []RuntimeStartInput
	validateErr            error
	validateCalls          []RuntimeExecInput
}

type fakeRuntimePreparer struct {
	result       agentsidecarservice.PreparedRuntime
	err          error
	input        *agentsidecarservice.PrepareInput
	cleanupCalls *[]agentsidecarservice.CleanupInput
}

func (f fakeRuntimePreparer) Prepare(_ context.Context, input agentsidecarservice.PrepareInput) (agentsidecarservice.PreparedRuntime, error) {
	if f.input != nil {
		*f.input = input
	}
	return f.result, f.err
}

func (f fakeRuntimePreparer) Cleanup(_ context.Context, input agentsidecarservice.CleanupInput) error {
	if f.cleanupCalls != nil {
		*f.cleanupCalls = append(*f.cleanupCalls, input)
	}
	return nil
}

type fakeModelCatalog struct {
	result AgentModelCatalogResult
	err    error
}

func (f fakeModelCatalog) ListModels(context.Context, string) (AgentModelCatalogResult, error) {
	return f.result, f.err
}

type fakeMessageReader struct {
	lastLimit *int
	page      SessionMessagesPage
}

type fakeSessionReader struct {
	reconciled *[]PersistedSession
	sessions   map[string]PersistedSession
}

func (f fakeMessageReader) ListSessionMessages(
	input agentactivitybiz.ListSessionMessagesInput,
) (SessionMessagesPage, bool) {
	if f.lastLimit != nil {
		*f.lastLimit = input.Limit
	}
	if input.AgentSessionID != "session-1" {
		return SessionMessagesPage{}, false
	}
	return f.page, true
}

func newFakeRuntime() *fakeRuntime {
	return &fakeRuntime{
		sessions: make(map[string]RuntimeSession),
	}
}

func (f *fakeRuntime) Cancel(_ context.Context, input RuntimeCancelInput) (RuntimeCancelResult, error) {
	f.cancelCalls = append(f.cancelCalls, input)
	if f.cancelResultSet {
		if f.cancelResult.AgentSessionID == "" {
			f.cancelResult.AgentSessionID = input.AgentSessionID
		}
		return f.cancelResult, nil
	}
	return RuntimeCancelResult{AgentSessionID: input.AgentSessionID, Canceled: true}, nil
}

func (f *fakeRuntime) Close(_ context.Context, input RuntimeCloseInput) error {
	f.closeCalls = append(f.closeCalls, input)
	if f.closeErr != nil {
		return f.closeErr
	}
	delete(f.sessions, input.WorkspaceID+":"+input.AgentSessionID)
	return nil
}

func (*fakeRuntime) CanResume(input RuntimeResumeInput) bool {
	return strings.TrimSpace(input.Provider) != ""
}

func (f *fakeRuntime) Exec(_ context.Context, input RuntimeExecInput) (RuntimeExecResult, error) {
	f.execCalls = append(f.execCalls, input)
	if f.execErr != nil {
		return RuntimeExecResult{}, f.execErr
	}
	key := input.WorkspaceID + ":" + input.AgentSessionID
	if session, ok := f.sessions[key]; ok {
		session.Status = "working"
		session.UpdatedAtUnixMS = time.Now().UnixMilli()
		f.sessions[key] = session
	}
	return RuntimeExecResult{
		AgentSessionID: input.AgentSessionID,
		Status:         "started",
		Accepted:       true,
		SessionStatus:  "working",
	}, nil
}

func (f *fakeRuntime) ValidatePromptContent(_ context.Context, input RuntimeExecInput) error {
	f.validateCalls = append(f.validateCalls, input)
	return f.validateErr
}

func (f *fakeRuntime) SubmitInteractive(_ context.Context, input RuntimeSubmitInteractiveInput) error {
	f.submitInteractiveCalls = append(f.submitInteractiveCalls, input)
	return nil
}

func (f *fakeRuntime) UpdateSettings(_ context.Context, input RuntimeUpdateSettingsInput) error {
	key := input.WorkspaceID + ":" + input.AgentSessionID
	session, ok := f.sessions[key]
	if !ok {
		return ErrSessionNotFound
	}
	settings := ComposerSettings{}
	if session.Settings != nil {
		settings = *session.Settings
	}
	if input.Settings.Model != nil {
		settings.Model = strings.TrimSpace(*input.Settings.Model)
	}
	if input.Settings.PermissionModeID != nil {
		settings.PermissionModeID = strings.TrimSpace(*input.Settings.PermissionModeID)
	}
	if input.Settings.PlanMode != nil {
		settings.PlanMode = *input.Settings.PlanMode
	}
	if input.Settings.ReasoningEffort != nil {
		settings.ReasoningEffort = strings.TrimSpace(*input.Settings.ReasoningEffort)
	}
	session.Settings = &settings
	session.UpdatedAtUnixMS = time.Now().UnixMilli()
	f.sessions[key] = session
	return nil
}

func (f *fakeRuntime) Resume(_ context.Context, input RuntimeResumeInput) (RuntimeSession, error) {
	f.resumeCalls = append(f.resumeCalls, input)
	session := RuntimeSession{
		ID:                input.AgentSessionID,
		Provider:          input.Provider,
		ProviderSessionID: input.ProviderSessionID,
		Cwd:               input.Cwd,
		Env:               append([]string(nil), input.Env...),
		Settings:          cloneComposerSettingsPointer(&input.Settings),
		Status:            input.Status,
		Title:             input.Title,
		WorkspaceID:       input.WorkspaceID,
		CreatedAtUnixMS:   input.CreatedAtUnixMS,
		UpdatedAtUnixMS:   input.UpdatedAtUnixMS,
	}
	f.sessions[input.WorkspaceID+":"+input.AgentSessionID] = session
	return session, nil
}

func (f *fakeRuntime) Session(workspaceID string, agentSessionID string) (RuntimeSession, bool) {
	session, ok := f.sessions[workspaceID+":"+agentSessionID]
	return session, ok
}

func (f *fakeRuntime) Sessions(workspaceID string) []RuntimeSession {
	result := make([]RuntimeSession, 0)
	for _, session := range f.sessions {
		if session.WorkspaceID == workspaceID {
			result = append(result, session)
		}
	}
	return result
}

func (f fakeSessionReader) GetSession(workspaceID string, agentSessionID string) (PersistedSession, bool) {
	session, ok := f.sessions[workspaceID+":"+agentSessionID]
	return session, ok
}

func (f fakeSessionReader) ListSessions(workspaceID string) ([]PersistedSession, bool) {
	result := make([]PersistedSession, 0)
	for _, session := range f.sessions {
		if session.WorkspaceID == workspaceID {
			result = append(result, session)
		}
	}
	return result, len(result) > 0
}

func (f fakeSessionReader) DeleteSession(_ context.Context, workspaceID string, agentSessionID string) (bool, error) {
	key := workspaceID + ":" + agentSessionID
	if _, ok := f.sessions[key]; !ok {
		return false, nil
	}
	delete(f.sessions, key)
	return true, nil
}

func (f fakeSessionReader) ReconcileStaleTurnOnResume(_ context.Context, session PersistedSession) error {
	if f.reconciled != nil {
		*f.reconciled = append(*f.reconciled, session)
	}
	key := strings.TrimSpace(session.WorkspaceID) + ":" + strings.TrimSpace(session.ID)
	if persisted, ok := f.sessions[key]; ok {
		persisted.Status = "ready"
		persisted.CurrentPhase = "idle"
		f.sessions[key] = persisted
	}
	return nil
}

func (f *fakeRuntime) Start(_ context.Context, input RuntimeStartInput) (RuntimeSession, error) {
	f.startCalls = append(f.startCalls, input)
	if f.startErr != nil {
		return RuntimeSession{}, f.startErr
	}
	f.nextID++
	now := time.Now().UnixMilli()
	id := strings.TrimSpace(input.AgentSessionID)
	if id == "" {
		id = "session-" + string(rune('0'+f.nextID))
	}
	session := RuntimeSession{
		ID:       id,
		Provider: input.Provider,
		Cwd:      input.Cwd,
		Settings: &ComposerSettings{
			Model:            input.Model,
			PermissionModeID: input.PermissionModeID,
			PlanMode:         input.PlanMode,
			ReasoningEffort:  input.ReasoningEffort,
		},
		Status:          "ready",
		Title:           input.Title,
		WorkspaceID:     input.WorkspaceID,
		CreatedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}
	f.sessions[input.WorkspaceID+":"+session.ID] = session
	return session, nil
}

func (*fakeRuntime) Subscribe(string, string) (<-chan RuntimeStreamEvent, func(), bool) {
	events := make(chan RuntimeStreamEvent)
	close(events)
	return events, func() {}, true
}

type activityProjectionRepoStub struct {
	stateResult   agentactivitybiz.StateReportResult
	stateInput    agentactivitybiz.SessionStateReport
	messageInput  agentactivitybiz.SessionMessageReport
	messageResult agentactivitybiz.MessageReportResult
}

func (*activityProjectionRepoStub) DeleteSession(context.Context, string, string) (bool, error) {
	return false, nil
}

func (*activityProjectionRepoStub) GetSession(context.Context, string, string) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{}, false, nil
}

func (*activityProjectionRepoStub) ListSessions(context.Context, string) ([]agentactivitybiz.Session, bool, error) {
	return nil, false, nil
}

func (*activityProjectionRepoStub) ListSessionMessages(context.Context, agentactivitybiz.ListSessionMessagesInput) (agentactivitybiz.MessagePage, bool, error) {
	return agentactivitybiz.MessagePage{}, false, nil
}

func (r *activityProjectionRepoStub) ReportSessionMessages(_ context.Context, input agentactivitybiz.SessionMessageReport) (agentactivitybiz.MessageReportResult, error) {
	r.messageInput = input
	return r.messageResult, nil
}

func (r *activityProjectionRepoStub) ReportSessionState(_ context.Context, input agentactivitybiz.SessionStateReport) (agentactivitybiz.StateReportResult, error) {
	r.stateInput = input
	return r.stateResult, nil
}

func (*activityProjectionRepoStub) UpdateSessionPinned(context.Context, string, string, bool) (agentactivitybiz.Session, bool, error) {
	return agentactivitybiz.Session{}, false, nil
}

type publishedActivityUpdate struct {
	workspaceID    string
	agentSessionID string
	eventType      string
	payload        map[string]any
}

type activityUpdatePublisherStub struct {
	events []publishedActivityUpdate
}

func (p *activityUpdatePublisherStub) PublishAgentActivityUpdated(_ context.Context, workspaceID string, agentSessionID string, eventType string, payload map[string]any) error {
	p.events = append(p.events, publishedActivityUpdate{
		workspaceID:    workspaceID,
		agentSessionID: agentSessionID,
		eventType:      eventType,
		payload:        payload,
	})
	return nil
}

func stringRef(value string) *string {
	return &value
}
