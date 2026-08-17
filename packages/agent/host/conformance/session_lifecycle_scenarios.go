package conformance

import (
	"context"
	"errors"
	"fmt"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
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

func runCreateWithInitialGoal(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{}); err != nil {
		return err
	}
	if _, _, err := driver.Create(ctx, "workspace-1", agenthost.CreateSessionInput{
		AgentSessionID: "session-ambiguous-initial-goal",
		AgentTargetID:  "target-1",
		Provider:       "codex",
		ClientSubmitID: "create-goal-ambiguous-1",
		InitialContent: []agenthost.PromptContentBlock{{
			Type: "text",
			Text: "ordinary prompt",
		}},
		InitialGoalControl: &agenthost.TypedGoalControl{
			Action:    "set",
			Objective: "ship the feature",
		},
	}); !errors.Is(err, agenthost.ErrInvalidArgument) {
		return fmt.Errorf("ambiguous initial goal error=%v", err)
	}
	if metrics := driver.Metrics(); metrics.StartCalls != 0 {
		return fmt.Errorf("ambiguous initial goal start calls=%d", metrics.StartCalls)
	}

	if err := driver.Reset(ctx, Fixture{CompleteGoalOnSet: true}); err != nil {
		return err
	}
	input := agenthost.CreateSessionInput{
		AgentSessionID:       "session-initial-goal",
		AgentTargetID:        "target-1",
		Provider:             "codex",
		ClientSubmitID:       "create-goal-submit-1",
		InitialDisplayPrompt: "/goal ship the feature",
		InitialGoalControl: &agenthost.TypedGoalControl{
			Action:    "set",
			Objective: "ship the feature",
		},
	}
	session, turnID, err := driver.Create(ctx, "workspace-1", input)
	if err != nil {
		return fmt.Errorf("create with typed initial goal: %w", err)
	}
	if session.SessionID != "session-initial-goal" || turnID != "" {
		return fmt.Errorf("create with typed initial goal = %#v turn %q", session, turnID)
	}
	if session.Title != "/goal ship the feature" {
		return fmt.Errorf("typed initial goal title=%q", session.Title)
	}
	goal, err := driver.GetGoalState(ctx, agenthost.SessionRef{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-initial-goal",
	})
	if err != nil {
		return fmt.Errorf("read typed initial goal: %w", err)
	}
	if goal.Goal["objective"] != "ship the feature" {
		return fmt.Errorf("typed initial goal = %#v", goal.Goal)
	}
	if goal.ExecutionPending {
		return fmt.Errorf("completed initial Goal retained execution pending: %#v", goal)
	}
	replayed, replayedTurnID, err := driver.Create(ctx, "workspace-1", input)
	if err != nil {
		return fmt.Errorf("retry create with typed initial goal: %w", err)
	}
	if replayed.SessionID != session.SessionID || replayedTurnID != "" {
		return fmt.Errorf(
			"retried typed initial goal = %#v turn %q, want session %q without turn",
			replayed,
			replayedTurnID,
			session.SessionID,
		)
	}
	metrics := driver.Metrics()
	if metrics.StartCalls != 1 || metrics.ExecCalls != 0 || metrics.GoalControlCalls != 1 {
		return fmt.Errorf(
			"create with typed initial goal calls start=%d exec=%d goal=%d",
			metrics.StartCalls,
			metrics.ExecCalls,
			metrics.GoalControlCalls,
		)
	}
	return nil
}

func runInitialGoalExecutionPending(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{}); err != nil {
		return err
	}
	ref := agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-initial-goal-execution-pending",
	}
	if _, turnID, err := driver.Create(ctx, ref.WorkspaceID, agenthost.CreateSessionInput{
		AgentSessionID: ref.AgentSessionID, AgentTargetID: "target-1", Provider: "codex",
		ClientSubmitID: "create-goal-execution-pending-1",
		InitialGoalControl: &agenthost.TypedGoalControl{
			Action: "set", Objective: "start autonomous execution",
		},
	}); err != nil {
		return fmt.Errorf("create initial Goal execution: %w", err)
	} else if turnID != "" {
		return fmt.Errorf("initial Goal manufactured turn %q", turnID)
	}
	goal, err := driver.GetGoalState(ctx, ref)
	if err != nil {
		return fmt.Errorf("read initial Goal execution state: %w", err)
	}
	if goal.SyncStatus != storesqlite.GoalSyncStatusSynced || !goal.ExecutionPending {
		return fmt.Errorf("initial Goal execution state=%#v", goal)
	}
	return nil
}

func runTypedInitialGoalWaitsForCanonicalRailInitialization(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{
		CompleteGoalOnSet:      true,
		RaceRuntimeStartReport: true,
		RailProjectPaths:       []string{"/workspace/selected-project"},
	}); err != nil {
		return err
	}
	input := agenthost.CreateSessionInput{
		AgentSessionID:       "session-initial-goal-rail-race",
		AgentTargetID:        "target-1",
		Provider:             "codex",
		ClientSubmitID:       "create-goal-rail-race-1",
		InitialDisplayPrompt: "/goal ship from the selected project",
		InitialGoalControl: &agenthost.TypedGoalControl{
			Action:    "set",
			Objective: "ship from the selected project",
		},
		RailPlacement: &agenthost.RailPlacement{
			Version:     1,
			Kind:        agenthost.RailPlacementKindProject,
			ProjectPath: "/workspace/selected-project",
		},
	}
	created, turnID, err := driver.Create(ctx, "workspace-1", input)
	if err != nil {
		return fmt.Errorf("create typed initial goal during runtime start report: %w", err)
	}
	if turnID != "" {
		return fmt.Errorf("typed initial goal race created turn %q", turnID)
	}
	wantRail := storesqlite.RailSectionKeyForProject("/workspace/selected-project")
	if created.RailSectionKey != wantRail {
		return fmt.Errorf(
			"typed initial goal race rail=%q, want %q",
			created.RailSectionKey,
			wantRail,
		)
	}

	replayed, replayedTurnID, err := driver.Create(ctx, "workspace-1", input)
	if err != nil {
		return fmt.Errorf("retry typed initial goal after runtime start report: %w", err)
	}
	if replayed.SessionID != created.SessionID || replayedTurnID != "" {
		return fmt.Errorf(
			"retried typed initial goal race=%#v turn=%q, want session %q without turn",
			replayed,
			replayedTurnID,
			created.SessionID,
		)
	}
	metrics := driver.Metrics()
	if metrics.StartCalls != 1 || metrics.RuntimeSessionPublishCalls != 1 ||
		metrics.GoalControlCalls != 1 || metrics.RuntimeStartReportWrites != 1 {
		return fmt.Errorf(
			"typed initial goal race calls start=%d publish=%d goal=%d runtimeReports=%d, want 1/1/1/1",
			metrics.StartCalls,
			metrics.RuntimeSessionPublishCalls,
			metrics.GoalControlCalls,
			metrics.RuntimeStartReportWrites,
		)
	}
	return nil
}

func runFailedCanonicalInitializationAbortsUnpublishedRuntime(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{
		RaceRuntimeStartReport:    true,
		FailSessionInitialization: true,
		RailProjectPaths:          []string{"/workspace/selected-project"},
	}); err != nil {
		return err
	}
	ref := agenthost.SessionRef{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-initialization-failure",
	}
	_, _, err := driver.Create(ctx, ref.WorkspaceID, agenthost.CreateSessionInput{
		AgentSessionID: ref.AgentSessionID,
		AgentTargetID:  "target-1",
		Provider:       "codex",
		ClientSubmitID: "create-initialization-failure-1",
		InitialGoalControl: &agenthost.TypedGoalControl{
			Action:    "set",
			Objective: "must not execute",
		},
		RailPlacement: &agenthost.RailPlacement{
			Version:     1,
			Kind:        agenthost.RailPlacementKindProject,
			ProjectPath: "/workspace/selected-project",
		},
	})
	if err == nil {
		return errors.New("failed canonical initialization returned nil error")
	}
	if _, readErr := driver.GetCanonicalSession(ctx, ref); !errors.Is(readErr, agenthost.ErrSessionNotFound) {
		return fmt.Errorf("canonical session after initialization failure error=%v", readErr)
	}
	metrics := driver.Metrics()
	if metrics.StartCalls != 1 || metrics.RuntimeSessionPublishCalls != 0 ||
		metrics.CloseCalls != 1 || metrics.GoalControlCalls != 0 ||
		metrics.RuntimeStartReportWrites != 0 {
		return fmt.Errorf(
			"failed canonical initialization calls start=%d publish=%d close=%d goal=%d runtimeReports=%d, want 1/0/1/0/0",
			metrics.StartCalls,
			metrics.RuntimeSessionPublishCalls,
			metrics.CloseCalls,
			metrics.GoalControlCalls,
			metrics.RuntimeStartReportWrites,
		)
	}
	return nil
}

func runCreateWithRailPlacement(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{RailProjectPaths: []string{"/workspace/project"}}); err != nil {
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
			SectionKey:  "project:/workspace/project",
		},
	}
	session, turnID, err := driver.Create(ctx, "workspace-1", input)
	if err != nil {
		return fmt.Errorf("create with explicit rail placement: %w", err)
	}
	if turnID == "" {
		return fmt.Errorf("create with explicit rail placement turn is empty")
	}
	wantKey := storesqlite.RailSectionKeyForProject("/workspace/project")
	if session.RailSectionKey != wantKey {
		return fmt.Errorf(
			"create with explicit rail placement key=%q, want %q",
			session.RailSectionKey,
			wantKey,
		)
	}
	metrics := driver.Metrics()
	if err := requireRuntimeRailPlacement(metrics.LastStartEnv, agenthost.RailPlacement{
		Version: 1, Kind: agenthost.RailPlacementKindProject,
		ProjectPath: "/workspace/project", SectionKey: wantKey,
	}); err != nil {
		return fmt.Errorf("create runtime: %w", err)
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

func runRecoverCanonicalSessionOnlyOnMatchingRail(
	ctx context.Context,
	driver RailPlacementRecoveryDriver,
) error {
	if err := driver.Reset(ctx, Fixture{RailProjectPaths: []string{"/workspace/project"}}); err != nil {
		return err
	}
	ref := agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-rail-recovery",
	}
	placement := &agenthost.RailPlacement{
		Version: 1, Kind: agenthost.RailPlacementKindProject,
		ProjectPath: "/workspace/project", SectionKey: "project:/workspace/project",
	}
	created, _, err := driver.Create(ctx, ref.WorkspaceID, agenthost.CreateSessionInput{
		AgentSessionID: ref.AgentSessionID, AgentTargetID: "target-1", Provider: "codex",
		RailPlacement: placement,
	})
	if err != nil {
		return fmt.Errorf("create session for rail recovery: %w", err)
	}
	recovered, err := driver.GetSessionWithRailPlacement(ctx, ref, &agenthost.RailPlacement{
		Version: 1, Kind: agenthost.RailPlacementKindProject,
		ProjectPath: "/workspace/project", SectionKey: "project:/ignored-by-normalization",
	})
	if err != nil {
		return fmt.Errorf("recover session on matching rail: %w", err)
	}
	if recovered.SessionID != created.SessionID || recovered.RailSectionKey != created.RailSectionKey {
		return fmt.Errorf("recovered session=%#v, want %#v", recovered, created)
	}
	if _, err := driver.GetSessionWithRailPlacement(ctx, ref, &agenthost.RailPlacement{
		Version: 1, Kind: agenthost.RailPlacementKindProject,
		ProjectPath: "/workspace/other-project",
	}); !errors.Is(err, agenthost.ErrRailPlacementConflict) {
		return fmt.Errorf("recover session on mismatched rail error=%v", err)
	}
	return nil
}

func runResumePersistedSession(ctx context.Context, driver Driver) error {
	fixture := Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-resume", Provider: "codex",
		ProviderSessionID: "provider-session-1", Cwd: "/workspace", Title: "Persisted", InitialTitleEstablished: true,
	}, Turn: &TurnSeed{
		TurnID: "turn-established", Phase: canonical.TurnPhaseSettled,
		Outcome: canonical.TurnOutcomeCompleted, RootProviderTurnID: "provider-turn-1",
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
	metrics := driver.Metrics()
	if metrics.ResumeCalls != 1 || metrics.StartCalls != 0 {
		return fmt.Errorf("resume calls resume=%d start=%d", metrics.ResumeCalls, metrics.StartCalls)
	}
	if err := requireRuntimeRailPlacement(metrics.LastResumeEnv, agenthost.RailPlacement{
		Version: 1, Kind: agenthost.RailPlacementKindConversations,
		SectionKey: storesqlite.RailSectionKeyConversations,
	}); err != nil {
		return fmt.Errorf("resume runtime: %w", err)
	}
	if cwd, found := environmentValue(metrics.LastResumeEnv, "TUTTI_AGENT_CWD"); !found || cwd != "/workspace" {
		return fmt.Errorf("resume runtime cwd env=%q found=%v, env=%#v", cwd, found, metrics.LastResumeEnv)
	}
	return nil
}

func runRejectUnestablishedProviderSession(ctx context.Context, driver Driver) error {
	for _, live := range []bool{false, true} {
		fixture := Fixture{
			Session: &SessionSeed{
				WorkspaceID: "workspace-1", AgentSessionID: "session-unestablished", Provider: "codex",
				ProviderSessionID: "provider-session-unestablished", Cwd: "/workspace", Live: live,
			},
			Turn: &TurnSeed{
				TurnID: "turn-canceled-before-provider-start", Phase: canonical.TurnPhaseSettled,
				Outcome: canonical.TurnOutcomeCanceled,
			},
		}
		if err := driver.Reset(ctx, fixture); err != nil {
			return err
		}
		_, err := driver.EnsureSession(ctx, agenthost.SessionRef{
			WorkspaceID: "workspace-1", AgentSessionID: "session-unestablished",
		})
		if !errors.Is(err, agenthost.ErrProviderSessionNotEstablished) {
			return fmt.Errorf("unestablished provider session live=%v error=%v", live, err)
		}
		if metrics := driver.Metrics(); metrics.ResumeCalls != 0 || metrics.StartCalls != 0 {
			return fmt.Errorf(
				"unestablished provider session live=%v calls resume=%d start=%d",
				live,
				metrics.ResumeCalls,
				metrics.StartCalls,
			)
		}
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

func runSendConnectorOnlyInput(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, liveSessionFixture("session-send-connector", "")); err != nil {
		return err
	}
	result, err := driver.SendInput(ctx, agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-send-connector",
	}, agenthost.SendInput{
		Content: []agenthost.PromptContentBlock{{Type: "connector", ConnectorKey: "lark-cli"}},
	})
	if err != nil {
		return fmt.Errorf("send connector-only input: %w", err)
	}
	if result.Session.SessionID != "session-send-connector" || result.TurnID == "" {
		return fmt.Errorf("send connector-only input result = %#v", result)
	}
	if metrics := driver.Metrics(); metrics.ExecCalls != 1 {
		return fmt.Errorf("send connector-only input exec calls=%d", metrics.ExecCalls)
	}
	return nil
}

func runNewTurnsRequireDurableProviderAcceptance(
	ctx context.Context,
	driver Driver,
) error {
	if err := driver.Reset(ctx, Fixture{}); err != nil {
		return err
	}
	_, _, err := driver.Create(ctx, "workspace-1", agenthost.CreateSessionInput{
		AgentSessionID: "session-acceptance-create",
		AgentTargetID:  "target-1",
		Provider:       "codex",
		InitialContent: []agenthost.PromptContentBlock{{
			Type: "text", Text: "create with durable acceptance",
		}},
		ClientSubmitID: "acceptance-create-1",
	})
	if err != nil {
		return fmt.Errorf("create with provider acceptance: %w", err)
	}
	if !driver.Metrics().LastExecRequiresProviderAcceptance {
		return errors.New("initial Turn did not require durable provider acceptance")
	}

	if err := driver.Reset(
		ctx,
		liveSessionFixture("session-acceptance-send", ""),
	); err != nil {
		return err
	}
	_, err = driver.SendInput(
		ctx,
		agenthost.SessionRef{
			WorkspaceID: "workspace-1", AgentSessionID: "session-acceptance-send",
		},
		agenthost.SendInput{
			Content: []agenthost.PromptContentBlock{{
				Type: "text", Text: "send with durable acceptance",
			}},
			ClientSubmitID: "acceptance-send-1",
		},
	)
	if err != nil {
		return fmt.Errorf("send with provider acceptance: %w", err)
	}
	if !driver.Metrics().LastExecRequiresProviderAcceptance {
		return errors.New("sent Turn did not require durable provider acceptance")
	}
	return nil
}

func runProviderlessCanonicalTerminalSettlesAndReplaysSubmission(
	ctx context.Context,
	driver Driver,
) error {
	providerlessDriver, ok := driver.(ProviderlessTerminalDriver)
	if !ok {
		return errors.New("conformance driver does not support providerless terminal execution")
	}
	if err := providerlessDriver.ResetProviderlessTerminalExec(ctx, nil); err != nil {
		return err
	}
	createInput := agenthost.CreateSessionInput{
		AgentSessionID: "session-providerless-terminal-create",
		AgentTargetID:  "target-1",
		Provider:       "codex",
		InitialContent: []agenthost.PromptContentBlock{{
			Type: "text", Text: "fail before provider identity",
		}},
		ClientSubmitID: "providerless-terminal-create-1",
	}
	_, firstCreateTurnID, err := driver.Create(ctx, "workspace-1", createInput)
	if err != nil {
		return fmt.Errorf("create with providerless canonical terminal: %w", err)
	}
	if err := requireCanonicalFailedTurn(
		ctx,
		driver,
		agenthost.SessionRef{
			WorkspaceID: "workspace-1", AgentSessionID: createInput.AgentSessionID,
		},
		firstCreateTurnID,
	); err != nil {
		return fmt.Errorf("initial providerless terminal: %w", err)
	}
	_, replayedCreateTurnID, err := driver.Create(ctx, "workspace-1", createInput)
	if err != nil {
		return fmt.Errorf("replay providerless initial submit: %w", err)
	}
	if firstCreateTurnID == "" || replayedCreateTurnID != firstCreateTurnID {
		return fmt.Errorf(
			"providerless initial replay turns first=%q replay=%q",
			firstCreateTurnID,
			replayedCreateTurnID,
		)
	}
	if metrics := driver.Metrics(); metrics.StartCalls != 1 || metrics.ExecCalls != 1 {
		return fmt.Errorf(
			"providerless initial replay calls start=%d exec=%d",
			metrics.StartCalls,
			metrics.ExecCalls,
		)
	}

	sendFixture := liveSessionFixture("session-providerless-terminal-send", "")
	if err := providerlessDriver.ResetProviderlessTerminalExec(
		ctx,
		sendFixture.Session,
	); err != nil {
		return err
	}
	ref := agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-providerless-terminal-send",
	}
	sendInput := agenthost.SendInput{
		Content: []agenthost.PromptContentBlock{{
			Type: "text", Text: "fail before provider identity",
		}},
		ClientSubmitID: "providerless-terminal-send-1",
	}
	firstSend, err := driver.SendInput(ctx, ref, sendInput)
	if err != nil {
		return fmt.Errorf("send with providerless canonical terminal: %w", err)
	}
	if err := requireCanonicalFailedTurn(ctx, driver, ref, firstSend.TurnID); err != nil {
		return fmt.Errorf("ordinary providerless terminal: %w", err)
	}
	replayedSend, err := driver.SendInput(ctx, ref, sendInput)
	if err != nil {
		return fmt.Errorf("replay providerless ordinary submit: %w", err)
	}
	if firstSend.TurnID == "" || replayedSend.TurnID != firstSend.TurnID {
		return fmt.Errorf(
			"providerless send replay turns first=%q replay=%q",
			firstSend.TurnID,
			replayedSend.TurnID,
		)
	}
	if metrics := driver.Metrics(); metrics.ExecCalls != 1 {
		return fmt.Errorf("providerless send replay exec calls=%d", metrics.ExecCalls)
	}
	return nil
}

func requireCanonicalFailedTurn(
	ctx context.Context,
	driver Driver,
	ref agenthost.SessionRef,
	turnID string,
) error {
	turnID = strings.TrimSpace(turnID)
	if turnID == "" {
		return errors.New("canonical Turn id is empty")
	}
	page, err := driver.ListSessionTurns(ctx, ref, agenthost.SessionTurnQuery{Limit: 20})
	if err != nil {
		return err
	}
	for _, turn := range page.Turns {
		if strings.TrimSpace(turn.TurnID) != turnID {
			continue
		}
		if strings.TrimSpace(turn.Phase) != "settled" ||
			strings.TrimSpace(turn.Outcome) != "failed" {
			return fmt.Errorf(
				"canonical Turn %q phase=%q outcome=%q, want settled/failed",
				turnID,
				turn.Phase,
				turn.Outcome,
			)
		}
		return nil
	}
	return fmt.Errorf("canonical Turn %q not found", turnID)
}

func runRejectedInitialSubmitDiscardsRuntime(
	ctx context.Context,
	driver Driver,
) error {
	if err := driver.Reset(ctx, Fixture{RejectInitialExec: true}); err != nil {
		return err
	}
	input := agenthost.CreateSessionInput{
		AgentSessionID: "session-rejected-create",
		AgentTargetID:  "target-1",
		Provider:       "codex",
		InitialContent: []agenthost.PromptContentBlock{{
			Type: "text", Text: "create with a rejected initial submit",
		}},
		ClientSubmitID: "rejected-create-1",
	}
	if _, _, err := driver.Create(ctx, "workspace-1", input); err == nil {
		return errors.New("rejected initial create unexpectedly succeeded")
	}
	metrics := driver.Metrics()
	if metrics.StartCalls != 1 || metrics.ExecCalls != 1 || metrics.CloseCalls != 1 {
		return fmt.Errorf(
			"rejected initial create calls start=%d exec=%d close=%d",
			metrics.StartCalls,
			metrics.ExecCalls,
			metrics.CloseCalls,
		)
	}
	if !metrics.LastClosePreservedCanonicalState {
		return errors.New("rejected initial create completed canonical state while discarding runtime")
	}
	if _, err := driver.GetCanonicalSession(ctx, agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: input.AgentSessionID,
	}); err != nil {
		return fmt.Errorf("read retained rejected session: %w", err)
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
