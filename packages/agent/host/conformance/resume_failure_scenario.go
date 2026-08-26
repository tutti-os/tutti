package conformance

import (
	"context"
	"errors"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func runFailedResumePreservesRecoverableState(ctx context.Context, driver Driver) error {
	resumeErr := errors.New("provider resume failed")
	fixture := Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-resume-failure", Provider: "codex",
		ProviderSessionID: "provider-session-1", Cwd: "/workspace", Title: "Persisted", InitialTitleEstablished: true,
	}, Turn: &TurnSeed{
		TurnID: "turn-established", Phase: canonical.TurnPhaseSettled,
		Outcome: canonical.TurnOutcomeCompleted, RootProviderTurnID: "provider-turn-1",
	}, ResumeErr: resumeErr}
	if err := driver.Reset(ctx, fixture); err != nil {
		return err
	}
	if _, err := driver.EnsureSession(ctx, agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-resume-failure",
	}); !errors.Is(err, resumeErr) {
		return fmt.Errorf("failed resume error=%v, want %v", err, resumeErr)
	}
	metrics := driver.Metrics()
	if metrics.ResumeCalls != 1 || metrics.CloseCalls != 1 || !metrics.LastClosePreservedCanonicalState {
		return fmt.Errorf("failed resume runtime cleanup metrics=%#v", metrics)
	}
	if metrics.RuntimePreparationCleanupCalls != 1 || !metrics.LastCleanupPreservedRecoverableState {
		return fmt.Errorf("failed resume preparation cleanup metrics=%#v", metrics)
	}
	return nil
}
