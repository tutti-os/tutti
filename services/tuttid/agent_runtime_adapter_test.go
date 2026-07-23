package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	agenthostadapter "github.com/tutti-os/tutti/packages/agent/daemon/hostadapter"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	_ "modernc.org/sqlite"
)

type unavailableAgentExtensionResumeResolver struct{}

func (unavailableAgentExtensionResumeResolver) ResolveAdapter(context.Context, agentruntime.AdapterResolveInput) (agentruntime.Adapter, error) {
	return nil, errors.New("adapter resolution must not run during resume eligibility checks")
}

type submitProvenanceAdapterTestProvider struct{}

func (submitProvenanceAdapterTestProvider) Provider() string { return "submit-provenance-test" }
func (submitProvenanceAdapterTestProvider) Start(context.Context, agentruntime.Session) ([]activityshared.Event, error) {
	return nil, nil
}
func (submitProvenanceAdapterTestProvider) Resume(context.Context, agentruntime.Session) error {
	return nil
}
func (submitProvenanceAdapterTestProvider) Close(context.Context, agentruntime.Session) error {
	return nil
}
func (submitProvenanceAdapterTestProvider) Exec(context.Context, agentruntime.Session, []agentruntime.PromptContentBlock, string, string, agentruntime.EventSink, agentruntime.CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}
func (submitProvenanceAdapterTestProvider) Cancel(context.Context, agentruntime.Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

type submitProvenanceAdapterTestReporter struct {
	provenance agentsessionstore.ReportActivityInput
}

type retryPromptPersistenceAdapter struct {
	received chan []agentruntime.PromptContentBlock
}

func (*retryPromptPersistenceAdapter) Provider() string { return "retry-persistence-test" }
func (*retryPromptPersistenceAdapter) Start(context.Context, agentruntime.Session) ([]activityshared.Event, error) {
	return nil, nil
}
func (*retryPromptPersistenceAdapter) Resume(context.Context, agentruntime.Session) error { return nil }
func (*retryPromptPersistenceAdapter) Close(context.Context, agentruntime.Session) error  { return nil }
func (a *retryPromptPersistenceAdapter) Exec(_ context.Context, _ agentruntime.Session, content []agentruntime.PromptContentBlock, _ string, _ string, _ agentruntime.EventSink, _ agentruntime.CommandSnapshotSink) ([]activityshared.Event, error) {
	copyContent := append([]agentruntime.PromptContentBlock(nil), content...)
	a.received <- copyContent
	return nil, nil
}
func (*retryPromptPersistenceAdapter) Cancel(context.Context, agentruntime.Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *retryPromptPersistenceAdapter) nextContent(t *testing.T) []agentruntime.PromptContentBlock {
	t.Helper()
	select {
	case content := <-a.received:
		return content
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for provider Exec")
		return nil
	}
}

func (*submitProvenanceAdapterTestReporter) Report(context.Context, agentsessionstore.ReportActivityInput) error {
	return nil
}

func (r *submitProvenanceAdapterTestReporter) ReportSubmitProvenance(_ context.Context, input agentsessionstore.ReportActivityInput) error {
	r.provenance = input
	return nil
}

func TestMapAgentRuntimeErrorPreservesInteractiveRecoveryCodes(t *testing.T) {
	tests := []struct {
		runtimeErr error
		serviceErr error
	}{
		{agentruntime.ErrInteractiveRequestNotLive, agentservice.ErrInteractiveRequestNotLive},
		{agentruntime.ErrInteractiveAlreadyAnswered, agentservice.ErrInteractiveAlreadyAnswered},
		{agentruntime.ErrSessionDisconnected, agentservice.ErrRuntimeSessionDisconnected},
	}
	for _, test := range tests {
		if err := mapAgentRuntimeError(test.runtimeErr); !errors.Is(err, test.serviceErr) {
			t.Fatalf("mapAgentRuntimeError(%v) = %v, want %v", test.runtimeErr, err, test.serviceErr)
		}
	}
}

func TestMapAgentRuntimeErrorPreservesStructuredProviderFailure(t *testing.T) {
	cause := errors.New("provider process rejected startup")
	runtimeErr := &agentruntime.AppError{
		Code:         "provider_auth_required",
		Message:      "Agent provider needs authentication",
		DebugMessage: "provider exited with status 1",
		Cause:        cause,
	}

	mapped := mapAgentRuntimeError(fmt.Errorf("runtime start: %w", runtimeErr))
	var providerErr *agenthost.ProviderError
	if !errors.As(mapped, &providerErr) {
		t.Fatalf("mapped error = %v, want ProviderError", mapped)
	}
	if providerErr.Code != runtimeErr.Code || providerErr.Message != runtimeErr.Message || providerErr.DebugMessage != runtimeErr.DebugMessage {
		t.Fatalf("ProviderError = %#v, want diagnostics from %#v", providerErr, runtimeErr)
	}
	if !errors.Is(mapped, cause) || !errors.Is(mapped, runtimeErr) {
		t.Fatalf("mapped error did not preserve runtime error chain: %v", mapped)
	}
}

func TestMapAgentRuntimeErrorDoesNotClassifyProviderTimeoutAsDefinitive(t *testing.T) {
	runtimeErr := &agentruntime.AppError{
		Code:    "request_failed",
		Message: "Agent provider request failed",
		Cause:   fmt.Errorf("provider response: %w", context.DeadlineExceeded),
	}

	mapped := mapAgentRuntimeError(runtimeErr)
	var providerErr *agenthost.ProviderError
	if errors.As(mapped, &providerErr) {
		t.Fatalf("mapped error = %#v, want recoverable timeout", providerErr)
	}
	if !errors.Is(mapped, context.DeadlineExceeded) {
		t.Fatalf("mapped error = %v, want deadline in error chain", mapped)
	}
}

func TestAgentRuntimeAdapterCanResumePreservesExtensionTargetBinding(t *testing.T) {
	controller := agentruntime.NewControllerWithAdapterResolver(nil, nil, unavailableAgentExtensionResumeResolver{})
	adapter := newAgentRuntimeAdapter(controller)

	if !adapter.CanResume(agentservice.RuntimeResumeInput{
		WorkspaceID:       "workspace-1",
		AgentSessionID:    "session-1",
		AgentTargetID:     "extension:codebuddy",
		Provider:          "acp:codebuddy",
		ProviderSessionID: "provider-session-1",
		ProviderTargetRef: map[string]any{
			"kind":                    "agent_extension",
			"provider":                "acp:codebuddy",
			"targetId":                "extension:codebuddy",
			"extensionInstallationId": "codebuddy@1.0.0",
		},
	}) {
		t.Fatal("CanResume() = false, want authorized extension session to remain resumable across the tuttid runtime adapter")
	}
}

func TestRuntimeCapabilityReferencesFromServicePreservesStructuredProvenance(t *testing.T) {
	got := runtimeCapabilityReferencesFromService([]agentservice.CapabilityReference{{
		Capability: "tutti",
		Source:     "slash_command",
	}})
	if len(got) != 1 || got[0] != (agentruntime.CapabilityReference{Capability: "tutti", Source: "slash_command"}) {
		t.Fatalf("runtime capability refs = %#v", got)
	}
}

func TestRuntimeTuttiModeSnapshotFromServicePreservesTypedRevision(t *testing.T) {
	source := &agentservice.TuttiModeTurnSnapshot{
		ActivationID: "activation-1",
		RevisionID:   "revision-7",
		Revision:     7,
		State:        "active",
		Source:       "slash_command",
	}
	got := runtimeTuttiModeSnapshotFromService(source)
	want := agentruntime.TuttiModeTurnSnapshot{
		ActivationID: "activation-1",
		RevisionID:   "revision-7",
		Revision:     7,
		State:        "active",
		Source:       "slash_command",
	}
	if got == nil || *got != want {
		t.Fatalf("runtime Tutti mode snapshot = %#v, want %#v", got, want)
	}

	// Runtime input owns its copy; later service mutations must not rewrite the
	// turn snapshot that the controller freezes.
	source.State = "inactive"
	if got.State != "active" {
		t.Fatalf("runtime Tutti mode snapshot mutated with source: %#v", got)
	}
}

func TestAgentRuntimeAdapterRejectsNewTurnWithoutCanonicalTurnID(t *testing.T) {
	adapter := newAgentRuntimeAdapter(nil)
	_, err := adapter.Exec(context.Background(), agentservice.RuntimeExecInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
	})
	if !errors.Is(err, agentservice.ErrInvalidArgument) {
		t.Fatalf("Exec() error = %v, want ErrInvalidArgument", err)
	}
}

func TestAgentRuntimeAdapterDelegatesTypedDurableSubmitProvenance(t *testing.T) {
	reporter := &submitProvenanceAdapterTestReporter{}
	controller := agentruntime.NewController(
		[]agentruntime.Adapter{submitProvenanceAdapterTestProvider{}},
		reporter,
	)
	if _, err := controller.Start(context.Background(), agentruntime.StartInput{
		RoomID: "workspace-1", AgentSessionID: "session-1", Provider: "submit-provenance-test", CWD: t.TempDir(),
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	adapter := newAgentRuntimeAdapter(controller)
	if err := adapter.DurablyReportSubmitProvenance(context.Background(), agentservice.RuntimeSubmitProvenanceInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1",
		ClientSubmitID: "submit-1", Content: agentservice.TextPromptContent("hello"),
		DisplayPrompt: "Visible hello",
	}); err != nil {
		t.Fatalf("DurablyReportSubmitProvenance() error = %v", err)
	}
	got := reporter.provenance
	if got.WorkspaceID != "workspace-1" || got.Source.AgentID != "session-1" || len(got.MessageUpdates) != 1 {
		t.Fatalf("provenance report = %#v", got)
	}
	message := got.MessageUpdates[0]
	if message.TurnID != "turn-1" || message.Payload["clientSubmitId"] != "submit-1" || message.Payload["displayPrompt"] != "Visible hello" {
		t.Fatalf("provenance message = %#v", message)
	}
}

func TestRetryTurnRestoresProductionPersistedRichPrompt(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	store := storesqlite.New(db, storesqlite.Options{})
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	projection := agentservice.NewActivityProjection(store)
	provider := &retryPromptPersistenceAdapter{received: make(chan []agentruntime.PromptContentBlock, 2)}
	controller := agentruntime.NewController([]agentruntime.Adapter{provider}, projection)
	if _, err := controller.Start(ctx, agentruntime.StartInput{
		RoomID: "workspace-1", AgentSessionID: "session-1", Provider: provider.Provider(), CWD: t.TempDir(),
	}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	workspaceStore := &agenthost.SQLiteWorkspaceStore{StoreForWorkspace: func(string) *storesqlite.Store { return store }}
	attachmentsRoot := t.TempDir()
	sourceRoot := filepath.Join(t.TempDir(), "source")
	if err := os.MkdirAll(sourceRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	pathImage := filepath.Join(sourceRoot, "path-image.png")
	if err := os.WriteFile(pathImage, []byte("path-image"), 0o600); err != nil {
		t.Fatal(err)
	}
	host := agenthost.New(agenthost.Config{
		CanonicalStore: workspaceStore,
		Runtime:        &agenthostadapter.RuntimeController{Backend: controller},
		Attachments: agentservice.PromptAttachmentStore{
			RootDir: attachmentsRoot, SourceRootDir: sourceRoot,
		},
	})
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	parent, err := host.SendInput(ctx, ref, agenthost.SendInput{
		TurnID: "parent-turn", ClientSubmitID: "parent-submit-1",
		Content: []agenthost.PromptContentBlock{
			{Type: "text", Text: "describe these images"},
			{Type: "image", MimeType: "image/png", Data: "ZGF0YS1pbWFnZQ==", Name: "data.png"},
			{Type: "image", MimeType: "image/png", URL: "https://example.com/image.png", Name: "remote.png"},
			{Type: "image", MimeType: "image/png", Path: pathImage, Name: "path.png"},
		},
	})
	if err != nil {
		t.Fatalf("SendInput() error = %v", err)
	}
	initial := provider.nextContent(t)
	if len(initial) != 4 || initial[0].Text != "describe these images" || initial[1].Data == "" || initial[2].URL == "" || initial[3].Data == "" {
		t.Fatalf("initial provider content = %#v", initial)
	}

	page, found, err := store.ListSessionMessages(ctx, storesqlite.ListSessionMessagesInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, TurnID: parent.TurnID, Limit: 10, Order: storesqlite.MessageOrderAsc,
	})
	if err != nil || !found || len(page.Messages) != 1 {
		t.Fatalf("stored submit message=%#v found=%v err=%v", page, found, err)
	}
	content, ok := page.Messages[0].Payload["content"].([]any)
	if !ok || len(content) != 4 {
		t.Fatalf("stored content dynamic type=%T value=%#v", page.Messages[0].Payload["content"], page.Messages[0].Payload["content"])
	}
	for _, index := range []int{1, 3} {
		block, ok := content[index].(map[string]any)
		if !ok || block["attachmentId"] == "" || block["mimeType"] != "image/png" || block["name"] == "" || block["data"] != nil || block["path"] != nil {
			t.Fatalf("persisted attachment block[%d]=%#v", index, content[index])
		}
	}
	remote, ok := content[2].(map[string]any)
	if !ok || remote["url"] != "https://example.com/image.png" || remote["name"] != "remote.png" {
		t.Fatalf("persisted URL block=%#v", content[2])
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, storesqlite.TurnTransition{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, TurnID: parent.TurnID,
		Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: time.Now().UnixMilli(),
	}); err != nil || !accepted {
		t.Fatalf("settle parent accepted=%v err=%v", accepted, err)
	}

	retry, err := host.RetryTurn(ctx, ref, agenthost.RetryTurnInput{ParentTurnID: parent.TurnID, ClientSubmitID: "retry-submit-1"})
	if err != nil {
		t.Fatalf("RetryTurn() error = %v", err)
	}
	retried := provider.nextContent(t)
	if retry.TurnID == parent.TurnID || len(retried) != 4 || retried[0].Text != "describe these images" ||
		retried[1].Data == "" || retried[1].AttachmentID == "" || retried[1].Name != "data.png" ||
		retried[2].URL != "https://example.com/image.png" || retried[2].Name != "remote.png" ||
		retried[3].Data == "" || retried[3].AttachmentID == "" || retried[3].Name != "path.png" {
		t.Fatalf("retried provider content = %#v", retried)
	}
}

func TestAgentRuntimeAdapterReturnsClaudeSDKModelConfigOptions(t *testing.T) {
	t.Setenv("TUTTI_CLAUDE_SDK_SIDECAR_TEST_DRIVER", "1")
	t.Setenv("TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH", "")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	controller := agentruntime.NewController(
		[]agentruntime.Adapter{agentruntime.NewClaudeCodeSDKAdapter(agentruntime.NewLocalProcessTransport())},
		nil,
	)
	adapter := newAgentRuntimeAdapter(controller)
	session, err := adapter.Start(ctx, agentservice.RuntimeStartInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "agent-session-1",
		Provider:       agentruntime.ProviderClaudeCode,
		Cwd:            t.TempDir(),
		Title:          "Claude Code",
		Model:          "haiku",
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer func() {
		_ = adapter.Close(context.Background(), agentservice.RuntimeCloseInput{
			WorkspaceID:    session.WorkspaceID,
			AgentSessionID: session.ID,
		})
	}()

	if !runtimeContextHasClaudeSDKModelConfigOptions(session.RuntimeContext) {
		t.Fatalf("RuntimeContext = %#v, want SDK model config options", session.RuntimeContext)
	}
}

func runtimeContextHasClaudeSDKModelConfigOptions(runtimeContext map[string]any) bool {
	options, ok := runtimeContext["configOptions"].([]map[string]any)
	if !ok {
		return false
	}
	for _, option := range options {
		if option["id"] != "model" || option["currentValue"] != "haiku" {
			continue
		}
		models, ok := option["options"].([]map[string]string)
		if !ok {
			return false
		}
		var sawDefault bool
		var sawHaiku bool
		for _, model := range models {
			if model["value"] == "default" {
				sawDefault = true
			}
			if model["value"] == "haiku" {
				sawHaiku = true
			}
		}
		return sawDefault && sawHaiku
	}
	return false
}
