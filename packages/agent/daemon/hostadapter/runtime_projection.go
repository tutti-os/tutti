package hostadapter

import (
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

func runtimeTuttiModeSnapshot(input *host.TuttiModeTurnSnapshot) *agentruntime.TuttiModeTurnSnapshot {
	if input == nil {
		return nil
	}
	legacyOrchestrationIntensity := input.OrchestrationIntensity //nolint:staticcheck // Compatibility bridge preserves version-zero snapshots.
	return &agentruntime.TuttiModeTurnSnapshot{
		ActivationID: input.ActivationID, RevisionID: input.RevisionID, Revision: input.Revision,
		State: input.State, Source: input.Source,
		PreferenceVersion:      input.PreferenceVersion,
		Effect:                 input.Effect,
		Speed:                  input.Speed,
		OrchestrationIntensity: legacyOrchestrationIntensity,
	}
}

func runtimeSettings(settings host.ComposerSettings) *agentruntime.SessionSettings {
	return &agentruntime.SessionSettings{
		CodexSaverMode: settings.CodexSaverMode,
		RTKSaverMode:   settings.RTKSaverMode,
		Model:          settings.Model, ReasoningEffort: settings.ReasoningEffort, Speed: settings.Speed,
		PlanMode: settings.PlanMode, BrowserUse: settings.BrowserUse, ComputerUse: settings.ComputerUse,
		PermissionModeID: settings.PermissionModeID, ConversationDetailMode: settings.ConversationDetailMode,
	}
}

func hostSettings(settings agentruntime.SessionSettings) host.ComposerSettings {
	return host.ComposerSettings{
		CodexSaverMode: settings.CodexSaverMode,
		RTKSaverMode:   settings.RTKSaverMode,
		Model:          settings.Model, ReasoningEffort: settings.ReasoningEffort, Speed: settings.Speed,
		PlanMode: settings.PlanMode, BrowserUse: settings.BrowserUse, ComputerUse: settings.ComputerUse,
		PermissionModeID: settings.PermissionModeID, ConversationDetailMode: settings.ConversationDetailMode,
	}
}

func hostTurnLifecyclePointer(input *agentruntime.TurnLifecycle) *host.TurnLifecycle {
	if input == nil {
		return nil
	}
	value := hostTurnLifecycle(*input)
	return &value
}

func hostTurnLifecycle(input agentruntime.TurnLifecycle) host.TurnLifecycle {
	var completed *host.CompletedCommand
	if input.CompletedCommand != nil {
		completed = &host.CompletedCommand{Kind: input.CompletedCommand.Kind, Status: input.CompletedCommand.Status}
	}
	return host.TurnLifecycle{
		ActiveTurnID: input.ActiveTurnID, Phase: input.Phase, Settling: input.Settling,
		Outcome: input.Outcome, CompletedCommand: completed,
	}
}

func runtimeTurnLifecyclePointer(input *host.TurnLifecycle) *agentruntime.TurnLifecycle {
	if input == nil {
		return nil
	}
	var completed *agentruntime.CompletedCommand
	if input.CompletedCommand != nil {
		completed = &agentruntime.CompletedCommand{
			Kind: input.CompletedCommand.Kind, Status: input.CompletedCommand.Status,
		}
	}
	return &agentruntime.TurnLifecycle{
		ActiveTurnID: input.ActiveTurnID, Phase: input.Phase, Settling: input.Settling,
		Outcome: input.Outcome, CompletedCommand: completed,
	}
}

func hostSubmitAvailability(input *agentruntime.SubmitAvailability) *host.SubmitAvailability {
	if input == nil {
		return nil
	}
	return &host.SubmitAvailability{State: input.State, Reason: input.Reason}
}

func runtimeSubmitAvailability(input *host.SubmitAvailability) *agentruntime.SubmitAvailability {
	if input == nil {
		return nil
	}
	return &agentruntime.SubmitAvailability{State: input.State, Reason: input.Reason}
}

func cloneMap(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	out := make(map[string]any, len(input))
	for key, value := range input {
		out[key] = value
	}
	return out
}
