package conformance

import (
	"context"
	"errors"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func runCreateEmptySession(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{}); err != nil {
		return err
	}
	session, turnID, err := driver.Create(ctx, "workspace-1", agenthost.CreateSessionInput{
		AgentSessionID: "session-empty", AgentTargetID: "target-1", Provider: "codex",
	})
	if err != nil {
		return fmt.Errorf("create empty session: %w", err)
	}
	if session.SessionID != "session-empty" || turnID != "" {
		return fmt.Errorf("create empty session = %#v turn %q", session, turnID)
	}
	if session.Title != "" {
		return fmt.Errorf("empty create canonical title=%q", session.Title)
	}
	metrics := driver.Metrics()
	if metrics.StartCalls != 1 || metrics.ExecCalls != 0 {
		return fmt.Errorf("create empty calls start=%d exec=%d", metrics.StartCalls, metrics.ExecCalls)
	}
	return nil
}

func runCreateWithInitialContent(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{}); err != nil {
		return err
	}
	input := agenthost.CreateSessionInput{
		AgentSessionID: "session-initial", AgentTargetID: "target-1", Provider: "codex",
		InitialContent: []agenthost.PromptContentBlock{{Type: "text", Text: "build the feature"}},
		Metadata:       map[string]any{"clientSubmitId": "caller-controlled"}, ClientSubmitID: "create-submit-1",
	}
	session, turnID, err := driver.Create(ctx, "workspace-1", input)
	if err != nil {
		return fmt.Errorf("create with initial content: %w", err)
	}
	if session.SessionID != "session-initial" || turnID == "" {
		return fmt.Errorf("create with initial content = %#v turn %q", session, turnID)
	}
	if err := verifyRetriedInitialCreate(ctx, driver, input, session, turnID); err != nil {
		return err
	}
	metrics := driver.Metrics()
	if metrics.StartCalls != 1 || metrics.ExecCalls != 1 {
		return fmt.Errorf("create with initial content calls start=%d exec=%d", metrics.StartCalls, metrics.ExecCalls)
	}
	return nil
}

func runCreateWithRailPlacement(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{}); err != nil {
		return err
	}
	input := agenthost.CreateSessionInput{
		AgentSessionID: "session-rail-placement",
		AgentTargetID:  "target-1",
		Provider:       "codex",
		InitialContent: []agenthost.PromptContentBlock{{Type: "text", Text: "build in caller project"}},
		ClientSubmitID: "create-rail-placement-1",
		RailPlacement: &agenthost.RailPlacement{
			Version:     1,
			Kind:        agenthost.RailPlacementKindProject,
			ProjectPath: "/workspace/project",
			SectionKey:  "project:workspace-1:/workspace/project",
		},
	}
	session, turnID, err := driver.Create(ctx, "workspace-1", input)
	if err != nil {
		return fmt.Errorf("create with explicit rail placement: %w", err)
	}
	if turnID == "" {
		return fmt.Errorf("create with explicit rail placement turn is empty")
	}
	if session.RailSectionKey != input.RailPlacement.SectionKey {
		return fmt.Errorf(
			"create with explicit rail placement key=%q, want %q",
			session.RailSectionKey,
			input.RailPlacement.SectionKey,
		)
	}
	if err := verifyRetriedInitialCreate(ctx, driver, input, session, turnID); err != nil {
		return err
	}
	conflictingRetry := input
	conflictingPlacement := *input.RailPlacement
	conflictingPlacement.ProjectPath = "/workspace/other-project"
	conflictingRetry.RailPlacement = &conflictingPlacement
	if _, _, err := driver.Create(ctx, "workspace-1", conflictingRetry); !errors.Is(
		err,
		agenthost.ErrRailPlacementConflict,
	) {
		return fmt.Errorf("retry with conflicting rail placement error=%v", err)
	}
	return nil
}

func runResumePersistedSession(ctx context.Context, driver Driver) error {
	fixture := Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-resume", Provider: "codex",
		ProviderSessionID: "provider-session-1", Cwd: "/workspace", Title: "Persisted", InitialTitleEstablished: true,
	}}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	session, err := driver.EnsureSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-resume"})
	if err != nil {
		return fmt.Errorf("resume persisted session: %w", err)
	}
	if session.SessionID != "session-resume" || session.ProviderSessionID != "provider-session-1" || !session.Resumable {
		return fmt.Errorf("resumed session = %#v", session)
	}
	if metrics := driver.Metrics(); metrics.ResumeCalls != 1 || metrics.StartCalls != 0 {
		return fmt.Errorf("resume calls resume=%d start=%d", metrics.ResumeCalls, metrics.StartCalls)
	}
	return nil
}

func runResumeImportedSession(ctx context.Context, driver Driver) error {
	fixture := Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-imported", Provider: "codex",
		ProviderSessionID: "imported-provider-session", Cwd: "/workspace", Origin: agenthost.WorkspaceAgentSessionOriginImported,
	}}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	if _, err := driver.EnsureSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-imported"}); err != nil {
		return fmt.Errorf("resume imported session: %w", err)
	}
	metrics := driver.Metrics()
	if metrics.ResumeCalls != 1 || !metrics.LastResumeRecreate {
		return fmt.Errorf("imported resume metrics=%#v", metrics)
	}
	return nil
}

func runRejectUnsupportedImport(ctx context.Context, driver Driver) error {
	supported := false
	return runRejectedResume(ctx, driver, SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-export", Provider: "codex",
		ProviderSessionID: "web-export", Origin: agenthost.WorkspaceAgentSessionOriginImported,
		ExternalResumeSupported: &supported,
	})
}

func runRejectChildResume(ctx context.Context, driver Driver) error {
	return runRejectedResume(ctx, driver, SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-child", Provider: "codex",
		ProviderSessionID: "child-provider", Kind: canonical.SessionKindChild,
	})
}

func runRejectTombstonedResume(ctx context.Context, driver Driver) error {
	return runRejectedResume(ctx, driver, SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-deleted", Provider: "codex",
		ProviderSessionID: "deleted-provider", Deleted: true,
	})
}

func runRejectedResume(ctx context.Context, driver Driver, seed SessionSeed) error {
	if err := driver.Reset(ctx, Fixture{Session: &seed}); err != nil {
		return err
	}
	_, err := driver.EnsureSession(ctx, agenthost.SessionRef{WorkspaceID: seed.WorkspaceID, AgentSessionID: seed.AgentSessionID})
	if !errors.Is(err, agenthost.ErrSessionNotFound) {
		return fmt.Errorf("rejected resume error=%v", err)
	}
	if metrics := driver.Metrics(); metrics.ResumeCalls != 0 {
		return fmt.Errorf("rejected resume calls=%d", metrics.ResumeCalls)
	}
	return nil
}

func runSendInput(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-send", "")); err != nil {
		return err
	}
	result, err := driver.SendInput(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-send"}, agenthost.SendInput{
		Content: []agenthost.PromptContentBlock{{Type: "text", Text: "continue"}},
	})
	if err != nil {
		return fmt.Errorf("send input: %w", err)
	}
	if result.Session.SessionID != "session-send" || result.TurnID == "" {
		return fmt.Errorf("send input result = %#v", result)
	}
	if metrics := driver.Metrics(); metrics.ExecCalls != 1 {
		return fmt.Errorf("send input exec calls=%d", metrics.ExecCalls)
	}
	return nil
}

func runDuplicateClientSubmitID(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-duplicate", "")); err != nil {
		return err
	}
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-duplicate"}
	input := agenthost.SendInput{
		Content:        []agenthost.PromptContentBlock{{Type: "text", Text: "only once"}},
		Metadata:       map[string]any{"clientSubmitId": "caller-controlled"},
		ClientSubmitID: "submit-duplicate-1",
	}
	first, err := driver.SendInput(ctx, ref, input)
	if err != nil {
		return fmt.Errorf("first idempotent send: %w", err)
	}
	duplicateInput := input
	duplicateInput.Metadata = map[string]any{"clientSubmitId": "different-caller-controlled"}
	duplicate, err := driver.SendInput(ctx, ref, duplicateInput)
	if err != nil {
		return fmt.Errorf("duplicate idempotent send: %w", err)
	}
	if first.TurnID == "" || duplicate.TurnID != first.TurnID {
		return fmt.Errorf("duplicate turns first=%q duplicate=%q", first.TurnID, duplicate.TurnID)
	}
	if metrics := driver.Metrics(); metrics.ExecCalls != 1 {
		return fmt.Errorf("duplicate submit exec calls=%d", metrics.ExecCalls)
	}
	return nil
}

func runPreparedSubmitClaim(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-prepared", "")
	fixture.PreparedSubmitID = "submit-prepared-1"
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	_, err := driver.SendInput(ctx,
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-prepared"},
		agenthost.SendInput{
			Content:  []agenthost.PromptContentBlock{{Type: "text", Text: "do not replay"}},
			Metadata: map[string]any{"clientSubmitId": "submit-prepared-1"},
		},
	)
	if !errors.Is(err, agenthost.ErrSubmitDeliveryUnknown) {
		return fmt.Errorf("prepared submit error=%v", err)
	}
	if metrics := driver.Metrics(); metrics.ExecCalls != 0 {
		return fmt.Errorf("prepared submit exec calls=%d", metrics.ExecCalls)
	}
	return nil
}
