package agenthost

import (
	"context"
	"fmt"
	"strings"
)

// GetSession reads canonical truth and, when present, the current provider
// observation without starting or resuming a runtime.
func (h *Host) GetSession(ctx context.Context, ref SessionRef) (GetSessionResult, error) {
	ref = normalizedSessionRef(ref)
	if h == nil || h.store == nil || h.runtime == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return GetSessionResult{}, ErrSessionNotFound
	}
	deleted, err := h.store.SessionDeleted(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return GetSessionResult{}, err
	}
	if deleted {
		return GetSessionResult{}, ErrSessionNotFound
	}
	canonical, found, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return GetSessionResult{}, err
	}
	live, liveFound := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID)
	if !found {
		if liveFound {
			return GetSessionResult{}, fmt.Errorf("live workspace agent session has no persisted session")
		}
		return GetSessionResult{}, ErrSessionNotFound
	}
	return GetSessionResult{Session: live, Canonical: canonical, Live: liveFound}, nil
}

// UpdateSettings preserves the established split: historical sessions update
// canonical settings directly, while live sessions apply the patch to the
// runtime first and then persist the resulting settings. The same per-session
// lock used by resume protects both paths.
func (h *Host) UpdateSettings(ctx context.Context, input UpdateSettingsInput) (UpdateSettingsResult, error) {
	ref := normalizedSessionRef(SessionRef{WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID})
	if h == nil || h.store == nil || h.sessionManagement == nil || h.runtime == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return UpdateSettingsResult{}, ErrInvalidArgument
	}
	release, err := h.acquireSession(ctx, ref)
	if err != nil {
		return UpdateSettingsResult{}, err
	}
	defer release()

	if _, live := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID); live {
		session, err := h.ensureRuntimeSessionLocked(ctx, ref)
		if err != nil {
			return UpdateSettingsResult{}, err
		}
		patch := input.Settings
		if h.settingsPolicy != nil {
			patch = h.settingsPolicy.NormalizeRuntimeSettingsPatch(ctx, session, patch)
		}
		if err := h.runtime.UpdateSettings(ctx, RuntimeUpdateSettingsInput{
			WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, Settings: patch,
		}); err != nil {
			return UpdateSettingsResult{}, err
		}
		result, err := h.GetSession(ctx, ref)
		if err != nil {
			return UpdateSettingsResult{}, err
		}
		settings := applyComposerSettingsPatch(composerSettingsFromMap(result.Canonical.Settings), patch)
		if result.Session.Settings != nil {
			settings = *result.Session.Settings
		}
		if h.settingsPolicy != nil {
			settings = h.settingsPolicy.NormalizePersistedSettings(ctx, result.Canonical, settings, patch)
		}
		canonical, updated, err := h.sessionManagement.UpdateSessionSettings(
			ctx,
			ref.WorkspaceID,
			ref.AgentSessionID,
			settings,
		)
		if err != nil {
			return UpdateSettingsResult{}, err
		}
		if !updated {
			return UpdateSettingsResult{}, ErrSessionNotFound
		}
		result.Canonical = canonical
		return UpdateSettingsResult(result), nil
	}

	canonical, found, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return UpdateSettingsResult{}, err
	}
	if !found {
		return UpdateSettingsResult{}, ErrSessionNotFound
	}
	settings := applyComposerSettingsPatch(composerSettingsFromMap(canonical.Settings), input.Settings)
	if h.settingsPolicy != nil {
		settings = h.settingsPolicy.NormalizePersistedSettings(ctx, canonical, settings, input.Settings)
	}
	canonical, updated, err := h.sessionManagement.UpdateSessionSettings(ctx, ref.WorkspaceID, ref.AgentSessionID, settings)
	if err != nil {
		return UpdateSettingsResult{}, err
	}
	if !updated {
		return UpdateSettingsResult{}, ErrSessionNotFound
	}
	return UpdateSettingsResult{Canonical: canonical}, nil
}

func (h *Host) UpdatePin(ctx context.Context, input UpdatePinInput) (UpdatePinResult, error) {
	ref := normalizedSessionRef(SessionRef{WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID})
	if h == nil || h.sessionManagement == nil || h.runtime == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return UpdatePinResult{}, ErrInvalidArgument
	}
	canonical, updated, err := h.sessionManagement.UpdateSessionPinned(ctx, ref.WorkspaceID, ref.AgentSessionID, input.Pinned)
	if err != nil {
		return UpdatePinResult{}, err
	}
	if !updated {
		return UpdatePinResult{}, ErrSessionNotFound
	}
	live, ok := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID)
	return UpdatePinResult{Session: live, Canonical: canonical, Live: ok}, nil
}

// DeleteSession closes a live runtime before writing the canonical tombstone.
// Authorization, binding deletion, and local view cleanup remain adapter work.
func (h *Host) DeleteSession(ctx context.Context, ref SessionRef) (DeleteSessionResult, error) {
	ref = normalizedSessionRef(ref)
	if h == nil || h.sessionManagement == nil || h.runtime == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return DeleteSessionResult{}, ErrInvalidArgument
	}
	result := DeleteSessionResult{}
	if _, live := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID); live {
		if err := h.runtime.Close(ctx, RuntimeCloseInput(ref)); err != nil {
			return DeleteSessionResult{}, err
		}
		result.RuntimeClosed = true
	}
	removed, err := h.sessionManagement.DeleteSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return DeleteSessionResult{}, err
	}
	result.CanonicalRemoved = removed
	result.Deleted = removed || result.RuntimeClosed
	if !result.Deleted {
		return DeleteSessionResult{}, ErrSessionNotFound
	}
	if h.preparation != nil {
		if err := h.preparation.Cleanup(ctx, RuntimeCleanupInput{
			WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		}); err != nil {
			return DeleteSessionResult{}, err
		}
	}
	return result, nil
}

func normalizedSessionRef(ref SessionRef) SessionRef {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	return ref
}

func applyComposerSettingsPatch(settings ComposerSettings, patch ComposerSettingsPatch) ComposerSettings {
	if patch.Model != nil {
		settings.Model = strings.TrimSpace(*patch.Model)
	}
	if patch.PermissionModeID != nil {
		settings.PermissionModeID = strings.TrimSpace(*patch.PermissionModeID)
	}
	if patch.PlanMode != nil {
		settings.PlanMode = *patch.PlanMode
	}
	if patch.BrowserUse != nil {
		value := *patch.BrowserUse
		settings.BrowserUse = &value
	}
	if patch.ComputerUse != nil {
		value := *patch.ComputerUse
		settings.ComputerUse = &value
	}
	if patch.ReasoningEffort != nil {
		settings.ReasoningEffort = strings.TrimSpace(*patch.ReasoningEffort)
	}
	if patch.Speed != nil {
		settings.Speed = strings.TrimSpace(*patch.Speed)
	}
	return settings
}
