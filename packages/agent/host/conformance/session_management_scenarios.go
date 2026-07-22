package conformance

import (
	"context"
	"errors"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

func runInitialTitleCAS(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{}); err != nil {
		return err
	}
	session, _, err := driver.Create(ctx, "workspace-1", agenthost.CreateSessionInput{
		AgentSessionID: "session-title", AgentTargetID: "target-1", Provider: "codex",
		InitialContent: []agenthost.PromptContentBlock{{Type: "text", Text: "Derived title"}},
	})
	if err != nil {
		return fmt.Errorf("create title session: %w", err)
	}
	if session.Title != "Derived title" {
		return fmt.Errorf("derived title=%q", session.Title)
	}
	session, err = driver.UpdateTitle(ctx, agenthost.UpdateTitleInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-title", Title: "Explicit title",
	})
	if err != nil {
		return fmt.Errorf("update explicit title: %w", err)
	}
	if session.Title != "Explicit title" {
		return fmt.Errorf("updated title=%q", session.Title)
	}
	result, err := driver.SendInput(ctx,
		agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-title"},
		agenthost.SendInput{Content: []agenthost.PromptContentBlock{{Type: "text", Text: "Must not replace title"}}},
	)
	if err != nil {
		return fmt.Errorf("send after explicit title: %w", err)
	}
	if result.Session.Title != "Explicit title" || driver.Metrics().LastInitialTitle != "" {
		return fmt.Errorf("title CAS result=%#v metrics=%#v", result, driver.Metrics())
	}
	return nil
}

func runClearCanonicalTitle(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-clear-title", "")); err != nil {
		return err
	}
	session, err := driver.UpdateTitle(ctx, agenthost.UpdateTitleInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-clear-title", Title: "",
	})
	if err != nil {
		return fmt.Errorf("clear canonical title: %w", err)
	}
	if session.Title != "" {
		return fmt.Errorf("cleared title=%q", session.Title)
	}
	return nil
}

func runGetSession(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("session-get", "")
	fixture.Session.Title = "canonical title"
	fixture.Session.Settings = agenthost.ComposerSettings{Model: "model-a", PermissionModeID: "auto", Speed: "standard"}
	fixture.Session.Pinned = true
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	result, err := driver.GetSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-get"})
	if err != nil {
		return fmt.Errorf("get session: %w", err)
	}
	if result.SessionID != "session-get" || result.Title != "canonical title" || !result.Live || !result.Pinned ||
		result.Settings.Model != "model-a" || result.Settings.PermissionModeID != "auto" {
		return fmt.Errorf("get session=%#v", result)
	}
	return nil
}

func runHistoricalAndLiveSettings(ctx context.Context, driver Driver) error {
	historical := Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-settings-history", Provider: "claude-code",
		ProviderSessionID: "provider-settings-history", Cwd: "/workspace",
		Settings: agenthost.ComposerSettings{Model: "model-a", PermissionModeID: "review"},
	}}
	if err := driver.Reset(ctx, historical); err != nil {
		return err
	}
	permissionMode := "acceptEdits"
	result, err := driver.UpdateSettings(ctx, agenthost.UpdateSettingsInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-settings-history",
		Settings: agenthost.ComposerSettingsPatch{PermissionModeID: &permissionMode},
	})
	if err != nil {
		return fmt.Errorf("update historical settings: %w", err)
	}
	if result.Live || result.Settings.Model != "model-a" || result.Settings.PermissionModeID != "acceptEdits" ||
		driver.Metrics().UpdateSettingsCalls != 0 || driver.Metrics().ResumeCalls != 0 {
		return fmt.Errorf("historical settings=%#v metrics=%#v", result, driver.Metrics())
	}

	live := liveSessionFixture("session-settings-live", "")
	live.Session.Settings = agenthost.ComposerSettings{Model: "model-a", PermissionModeID: "review"}
	if err := driver.Reset(ctx, live); err != nil {
		return err
	}
	planMode := true
	result, err = driver.UpdateSettings(ctx, agenthost.UpdateSettingsInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-settings-live",
		Settings: agenthost.ComposerSettingsPatch{PlanMode: &planMode},
	})
	if err != nil {
		return fmt.Errorf("update live settings: %w", err)
	}
	if !result.Live || !result.Settings.PlanMode || result.Settings.Model != "model-a" ||
		driver.Metrics().UpdateSettingsCalls != 1 {
		return fmt.Errorf("live settings=%#v metrics=%#v", result, driver.Metrics())
	}
	canonical, err := driver.GetCanonicalSession(ctx, agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-settings-live",
	})
	if err != nil {
		return fmt.Errorf("get canonical live settings: %w", err)
	}
	if canonical.Live || !canonical.Settings.PlanMode || canonical.Settings.Model != "model-a" {
		return fmt.Errorf("canonical live settings=%#v", canonical)
	}
	return nil
}

func runPinSession(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-pin", Provider: "codex", Cwd: "/workspace",
	}}); err != nil {
		return err
	}
	result, err := driver.UpdatePin(ctx, agenthost.UpdatePinInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-pin", Pinned: true,
	})
	if err != nil {
		return fmt.Errorf("pin session: %w", err)
	}
	if !result.Pinned {
		return fmt.Errorf("pinned session=%#v", result)
	}
	result, err = driver.UpdatePin(ctx, agenthost.UpdatePinInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-pin", Pinned: false,
	})
	if err != nil {
		return fmt.Errorf("unpin session: %w", err)
	}
	if result.Pinned {
		return fmt.Errorf("unpinned session=%#v", result)
	}
	return nil
}

func runDeleteSession(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-delete", "")); err != nil {
		return err
	}
	result, err := driver.DeleteSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-delete"})
	if err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	if !result.Deleted || !result.RuntimeClosed || !result.CanonicalRemoved || driver.Metrics().CloseCalls != 1 {
		return fmt.Errorf("delete result=%#v metrics=%#v", result, driver.Metrics())
	}
	if _, err := driver.GetSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-delete"}); !errors.Is(err, agenthost.ErrSessionNotFound) {
		return fmt.Errorf("get deleted session error=%v", err)
	}
	return nil
}

func runDeleteLiveSessionBeforeCanonicalReport(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{LiveOnlySession: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-delete-live-only", Provider: "codex",
		ProviderSessionID: "provider-session-delete-live-only", Cwd: "/workspace", Live: true,
	}}); err != nil {
		return err
	}
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-delete-live-only"}
	result, err := driver.DeleteSession(ctx, ref)
	if err != nil {
		return fmt.Errorf("delete live-only session: %w", err)
	}
	if !result.Deleted || !result.RuntimeClosed || result.CanonicalRemoved || driver.Metrics().CloseCalls != 1 {
		return fmt.Errorf("delete live-only result=%#v metrics=%#v", result, driver.Metrics())
	}
	if _, err := driver.GetSession(ctx, ref); !errors.Is(err, agenthost.ErrSessionNotFound) {
		return fmt.Errorf("get deleted live-only session error=%v", err)
	}
	return nil
}
