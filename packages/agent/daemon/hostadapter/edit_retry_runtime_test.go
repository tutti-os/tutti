package hostadapter

import (
	"context"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

type editRetryRuntimeBackend struct {
	RuntimeBackend
	execInput     agentruntime.ExecInput
	historyInput  agentruntime.EffectiveHistoryInput
	rollbackInput agentruntime.EffectiveHistoryInput
}

func (backend *editRetryRuntimeBackend) Exec(
	_ context.Context,
	input agentruntime.ExecInput,
) (agentruntime.ExecResult, error) {
	backend.execInput = input
	return agentruntime.ExecResult{
		ProviderDispatch: &agentruntime.ProviderDispatchResult{
			Disposition: agentruntime.DispatchDispositionApplied,
			Acceptance: &agentruntime.ProviderAcceptanceReceipt{
				Source:            agentruntime.AcceptanceSourceTurnStartResponse,
				ProviderSessionID: "provider-session-1",
				ProviderTurnID:    "provider-turn-1",
			},
		},
	}, nil
}

func (*editRetryRuntimeBackend) SupportsEffectiveHistory(
	context.Context,
	agentruntime.EffectiveHistoryInput,
) (bool, error) {
	return true, nil
}

func (backend *editRetryRuntimeBackend) ReadEffectiveHistory(
	_ context.Context,
	input agentruntime.EffectiveHistoryInput,
) (agentruntime.EffectiveHistorySnapshot, error) {
	backend.historyInput = input
	return agentruntime.EffectiveHistorySnapshot{
		ProviderSessionID: "provider-session-1",
		Turns: []agentruntime.EffectiveHistoryTurn{{
			ID: "provider-turn-1", Status: "completed",
			ClientUserMessageID: "replacement-turn-1",
		}},
	}, nil
}

func (backend *editRetryRuntimeBackend) RollbackLatestTurn(
	_ context.Context,
	input agentruntime.EffectiveHistoryInput,
) (agentruntime.HistoryMutationResult, error) {
	backend.rollbackInput = input
	snapshot := agentruntime.EffectiveHistorySnapshot{
		ProviderSessionID: "provider-session-1",
	}
	return agentruntime.HistoryMutationResult{
		Disposition: agentruntime.DispatchDispositionApplied,
		Snapshot:    &snapshot,
	}, nil
}

func TestRuntimeControllerProjectsEditRetryProviderContracts(t *testing.T) {
	backend := &editRetryRuntimeBackend{}
	controller := &RuntimeController{Backend: backend}

	exec, err := controller.Exec(t.Context(), host.RuntimeExecInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		TurnID: "replacement-turn-1", ClientSubmitID: "replacement-submit-1",
		HistoryReplacement: true, RequireProviderAcceptance: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !backend.execInput.HistoryReplacement ||
		exec.ProviderDispatch.Disposition != host.RuntimeDispatchDispositionApplied ||
		exec.ProviderDispatch.Acceptance == nil ||
		exec.ProviderDispatch.Acceptance.Source != host.RuntimeAcceptanceSourceTurnStartResponse ||
		exec.ProviderDispatch.Acceptance.ProviderTurnID != "provider-turn-1" {
		t.Fatalf("exec input=%#v result=%#v", backend.execInput, exec)
	}

	historyInput := host.RuntimeHistoryInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Provider: "codex",
	}
	history, err := controller.ReadEffectiveHistory(t.Context(), historyInput)
	if err != nil {
		t.Fatal(err)
	}
	if backend.historyInput.RoomID != historyInput.WorkspaceID ||
		len(history.Turns) != 1 ||
		history.Turns[0].ClientUserMessageID != "replacement-turn-1" {
		t.Fatalf("history input=%#v result=%#v", backend.historyInput, history)
	}

	rollback, err := controller.RollbackLatestTurn(t.Context(), historyInput)
	if err != nil {
		t.Fatal(err)
	}
	if backend.rollbackInput.AgentSessionID != historyInput.AgentSessionID ||
		rollback.Disposition != host.RuntimeDispatchDispositionApplied ||
		rollback.Snapshot == nil ||
		rollback.Snapshot.ProviderSessionID != "provider-session-1" {
		t.Fatalf("rollback input=%#v result=%#v", backend.rollbackInput, rollback)
	}
}
