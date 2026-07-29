package conformance

import (
	"context"
	"errors"
	"fmt"
	"slices"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

var errDeleteAdmissionRejected = errors.New("delete admission rejected")

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

func runListSessionTurns(ctx context.Context, driver Driver) error {
	fixture := Fixture{
		Session: &SessionSeed{
			WorkspaceID: "workspace-1", AgentSessionID: "session-turns", Provider: "codex",
		},
		Turn: &TurnSeed{
			TurnID: "turn-1", Phase: "settled", Outcome: "completed",
			StartedAtUnixMS: 10, SettledAtUnixMS: 11,
		},
		AdditionalTurns: []TurnSeed{
			{TurnID: "turn-2", Phase: "settled", Outcome: "completed", StartedAtUnixMS: 20, SettledAtUnixMS: 21},
			{TurnID: "turn-3", Phase: "running", StartedAtUnixMS: 30},
		},
	}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-turns"}
	first, err := driver.ListSessionTurns(ctx, ref, agenthost.SessionTurnQuery{Limit: 2})
	if err != nil {
		return fmt.Errorf("list first session turn page: %w", err)
	}
	if len(first.Turns) != 2 || first.Turns[0].TurnID != "turn-3" ||
		first.Turns[1].TurnID != "turn-2" || !first.HasMore {
		return fmt.Errorf("first session turn page=%#v", first)
	}
	second, err := driver.ListSessionTurns(ctx, ref, agenthost.SessionTurnQuery{
		Before: &agenthost.SessionTurnCursor{
			StartedAtUnixMS: first.Turns[1].StartedAtUnixMS,
			TurnID:          first.Turns[1].TurnID,
		},
		Limit: 2,
	})
	if err != nil {
		return fmt.Errorf("list second session turn page: %w", err)
	}
	if len(second.Turns) != 1 || second.Turns[0].TurnID != "turn-1" || second.HasMore {
		return fmt.Errorf("second session turn page=%#v", second)
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
	replay, err := driver.DeleteSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-delete"})
	if err != nil {
		return fmt.Errorf("replay delete session: %w", err)
	}
	if replay.Deleted || replay.RuntimeClosed || replay.CanonicalRemoved || replay.CleanupFailed {
		return fmt.Errorf("replay delete result=%#v, want a successful no-op", replay)
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

func runDeleteAdmissionRejection(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("root-delete-rejected", "")
	fixture.AdditionalSessions = []SessionSeed{{
		WorkspaceID: "workspace-1", AgentSessionID: "child-delete-rejected",
		Provider: "codex", ParentAgentSessionID: "root-delete-rejected", Live: true,
	}}
	fixture.DeleteSessionPlans = [][]string{{"child-delete-rejected", "root-delete-rejected"}}
	fixture.DeleteAdmissionErr = errDeleteAdmissionRejected
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}

	_, err := driver.DeleteSessions(ctx, agenthost.DeleteSessionsInput{
		WorkspaceID: "workspace-1", SessionIDs: []string{"root-delete-rejected"},
	})
	if !errors.Is(err, errDeleteAdmissionRejected) {
		return fmt.Errorf("delete rejection error=%v", err)
	}
	metrics := driver.Metrics()
	wantPlan := agenthost.DeleteSessionsPlan{
		WorkspaceID: "workspace-1", SessionIDs: []string{"child-delete-rejected", "root-delete-rejected"},
	}
	if metrics.CloseCalls != 0 || metrics.CanonicalDeleteCalls != 0 || len(metrics.DeleteReports) != 0 ||
		len(metrics.DeleteAdmissionPlans) != 1 || !equalDeleteSessionsPlan(metrics.DeleteAdmissionPlans[0], wantPlan) {
		return fmt.Errorf("delete rejection metrics=%#v", metrics)
	}
	for _, sessionID := range wantPlan.SessionIDs {
		session, getErr := driver.GetSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: sessionID})
		if getErr != nil || !session.Live {
			return fmt.Errorf("session %q after rejection=%#v error=%v", sessionID, session, getErr)
		}
	}
	return nil
}

func runDeleteAdmissionExactClosure(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("root-delete-exact", "")
	fixture.AdditionalSessions = []SessionSeed{{
		WorkspaceID: "workspace-1", AgentSessionID: "child-delete-exact",
		Provider: "codex", ParentAgentSessionID: "root-delete-exact", Live: true,
	}}
	fixture.DeleteSessionPlans = [][]string{{"child-delete-exact", "root-delete-exact"}}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}

	result, err := driver.DeleteSessions(ctx, agenthost.DeleteSessionsInput{
		WorkspaceID: "workspace-1", SessionIDs: []string{"root-delete-exact"},
	})
	if err != nil {
		return fmt.Errorf("delete exact closure: %w", err)
	}
	wantPlan := agenthost.DeleteSessionsPlan{
		WorkspaceID: "workspace-1", SessionIDs: []string{"child-delete-exact", "root-delete-exact"},
	}
	metrics := driver.Metrics()
	if len(metrics.DeleteAdmissionPlans) != 1 || !equalDeleteSessionsPlan(metrics.DeleteAdmissionPlans[0], wantPlan) {
		return fmt.Errorf("delete admission plans=%#v, want %#v", metrics.DeleteAdmissionPlans, wantPlan)
	}
	if len(metrics.DeleteReports) != 1 || metrics.DeleteReports[0].Err != nil ||
		!equalDeleteSessionsPlan(metrics.DeleteReports[0].Plan, wantPlan) ||
		!slices.Equal(metrics.DeleteReports[0].Result.RemovedSessionIDs, result.RemovedSessionIDs) {
		return fmt.Errorf("delete reports=%#v result=%#v", metrics.DeleteReports, result)
	}
	return nil
}

func runDeleteAdmissionReplan(ctx context.Context, driver Driver) error {
	fixture := liveSessionFixture("root-delete-replan", "")
	fixture.AdditionalSessions = []SessionSeed{{
		WorkspaceID: "workspace-1", AgentSessionID: "child-delete-replan",
		Provider: "codex", ParentAgentSessionID: "root-delete-replan", Live: true,
	}}
	fixture.DeleteSessionPlans = [][]string{
		{"root-delete-replan"},
		{"child-delete-replan", "root-delete-replan"},
	}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}

	result, err := driver.DeleteSessions(ctx, agenthost.DeleteSessionsInput{
		WorkspaceID: "workspace-1", SessionIDs: []string{"root-delete-replan"},
	})
	if err != nil {
		return fmt.Errorf("delete changed closure: %w", err)
	}
	first := agenthost.DeleteSessionsPlan{WorkspaceID: "workspace-1", SessionIDs: []string{"root-delete-replan"}}
	second := agenthost.DeleteSessionsPlan{
		WorkspaceID: "workspace-1", SessionIDs: []string{"child-delete-replan", "root-delete-replan"},
	}
	metrics := driver.Metrics()
	if len(metrics.DeleteAdmissionPlans) != 2 ||
		!equalDeleteSessionsPlan(metrics.DeleteAdmissionPlans[0], first) ||
		!equalDeleteSessionsPlan(metrics.DeleteAdmissionPlans[1], second) {
		return fmt.Errorf("replanned delete admissions=%#v", metrics.DeleteAdmissionPlans)
	}
	if len(metrics.DeleteReports) != 2 ||
		metrics.DeleteReports[0].Err == nil ||
		!equalDeleteSessionsPlan(metrics.DeleteReports[0].Plan, first) ||
		!slices.Equal(metrics.DeleteReports[0].Result.RuntimeClosedIDs, []string{"root-delete-replan"}) ||
		metrics.DeleteReports[1].Err != nil ||
		!equalDeleteSessionsPlan(metrics.DeleteReports[1].Plan, second) {
		return fmt.Errorf("replanned delete reports=%#v", metrics.DeleteReports)
	}
	if !slices.Equal(result.RuntimeClosedIDs, []string{"child-delete-replan", "root-delete-replan"}) {
		return fmt.Errorf("replanned runtime closes=%#v", result.RuntimeClosedIDs)
	}
	wantEvents := []string{
		"admit:root-delete-replan",
		"close:root-delete-replan",
		"delete:root-delete-replan",
		"report-failure:root-delete-replan",
		"admit:child-delete-replan,root-delete-replan",
		"close:child-delete-replan",
		"delete:child-delete-replan,root-delete-replan",
		"report-success:child-delete-replan,root-delete-replan",
	}
	if !slices.Equal(metrics.DeletionEvents, wantEvents) {
		return fmt.Errorf("replanned deletion events=%#v, want %#v", metrics.DeletionEvents, wantEvents)
	}
	return nil
}

func equalDeleteSessionsPlan(left, right agenthost.DeleteSessionsPlan) bool {
	return left.WorkspaceID == right.WorkspaceID && slices.Equal(left.SessionIDs, right.SessionIDs)
}
