package agenthost

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
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

// DeleteSession and DeleteSessions share one deletion coordinator so child
// expansion, runtime shutdown, canonical tombstones, and goal mutation
// serialization cannot diverge between entry points.
func (h *Host) DeleteSession(ctx context.Context, ref SessionRef) (DeleteSessionResult, error) {
	ref = normalizedSessionRef(ref)
	if h == nil || h.sessionBatchManagement == nil || h.runtime == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return DeleteSessionResult{}, ErrInvalidArgument
	}
	batch, err := h.DeleteSessions(ctx, DeleteSessionsInput{
		WorkspaceID: ref.WorkspaceID,
		SessionIDs:  []string{ref.AgentSessionID},
	})
	if err != nil {
		return DeleteSessionResult{}, err
	}
	result := DeleteSessionResult{
		Deleted:          len(batch.RemovedSessionIDs) > 0 || len(batch.RuntimeClosedIDs) > 0,
		RuntimeClosed:    containsSessionID(batch.RuntimeClosedIDs, ref.AgentSessionID),
		CanonicalRemoved: containsSessionID(batch.RemovedSessionIDs, ref.AgentSessionID),
		CleanupFailed:    len(batch.CleanupFailedIDs) > 0,
	}
	if !result.Deleted {
		return DeleteSessionResult{}, ErrSessionNotFound
	}
	return result, nil
}

// DeleteSessions closes every selected live runtime before committing one
// canonical batch tombstone transaction. A missing batch store is reported as
// unsupported; Host never degrades this command into sequential deletes.
func (h *Host) DeleteSessions(ctx context.Context, input DeleteSessionsInput) (DeleteSessionsResult, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	sessionIDs := normalizedUniqueSessionIDs(input.SessionIDs)
	if h == nil || h.sessionBatchManagement == nil || h.runtime == nil || workspaceID == "" || len(sessionIDs) == 0 {
		return DeleteSessionsResult{}, ErrInvalidArgument
	}
	runtimeClosedIDs := make([]string, 0, len(sessionIDs))
	var deleted storesqlite.DeleteSessionsBatchResult
	for {
		plan, err := h.sessionBatchManagement.PlanDeleteSessions(ctx, storesqlite.DeleteSessionsBatchInput{
			WorkspaceID: workspaceID,
			SessionIDs:  sessionIDs,
		})
		if err != nil {
			return DeleteSessionsResult{}, err
		}
		// Requested sessions can be live before their first canonical report is
		// committed (for example, short-lived hidden discovery sessions). Keep
		// those runtimes inside the same deletion coordinator even when the
		// canonical plan is empty; the canonical plan remains the exact fence for
		// rows that do exist.
		mutationSessionIDs := normalizedUniqueSessionIDs(append(append([]string(nil), plan.SessionIDs...), sessionIDs...))
		err = h.withSessionMutationActors(ctx, workspaceID, mutationSessionIDs, func(commandCtx context.Context) error {
			releases := make([]func(), 0, len(mutationSessionIDs))
			for _, sessionID := range mutationSessionIDs {
				release, acquireErr := h.acquireSession(commandCtx, SessionRef{WorkspaceID: workspaceID, AgentSessionID: sessionID})
				if acquireErr != nil {
					releaseSessionLocks(releases)
					return acquireErr
				}
				releases = append(releases, release)
			}
			defer releaseSessionLocks(releases)
			for _, sessionID := range mutationSessionIDs {
				if _, live := h.runtime.Session(workspaceID, sessionID); !live {
					continue
				}
				if closeErr := h.runtime.Close(commandCtx, RuntimeCloseInput{WorkspaceID: workspaceID, AgentSessionID: sessionID}); closeErr != nil {
					return closeErr
				}
				runtimeClosedIDs = append(runtimeClosedIDs, sessionID)
			}
			if len(plan.SessionIDs) == 0 {
				return nil
			}
			var deleteErr error
			deleted, deleteErr = h.sessionBatchManagement.DeleteSessionsBatch(commandCtx, storesqlite.DeleteSessionsBatchInput{
				WorkspaceID:        workspaceID,
				SessionIDs:         sessionIDs,
				ExpectedSessionIDs: plan.SessionIDs,
			})
			return deleteErr
		})
		if errors.Is(err, storesqlite.ErrDeleteSessionsPlanChanged) {
			if ctx.Err() != nil {
				return DeleteSessionsResult{}, ctx.Err()
			}
			continue
		}
		if err != nil {
			return DeleteSessionsResult{}, err
		}
		break
	}
	runtimeClosedIDs = normalizedUniqueSessionIDs(runtimeClosedIDs)
	cleanupSessionIDs := normalizedUniqueSessionIDs(append(append([]string(nil), deleted.RemovedSessionIDs...), runtimeClosedIDs...))
	cleanupFailedIDs := make([]string, 0)
	for _, sessionID := range cleanupSessionIDs {
		if h.preparation == nil {
			continue
		}
		if err := h.preparation.Cleanup(ctx, RuntimeCleanupInput{WorkspaceID: workspaceID, AgentSessionID: sessionID}); err != nil {
			cleanupFailedIDs = append(cleanupFailedIDs, sessionID)
		}
	}
	return DeleteSessionsResult{
		RemovedSessionIDs: append([]string(nil), deleted.RemovedSessionIDs...),
		RemovedSessions:   deleted.RemovedSessions,
		RemovedMessages:   deleted.RemovedMessages,
		RuntimeClosedIDs:  runtimeClosedIDs,
		CleanupFailedIDs:  cleanupFailedIDs,
	}, nil
}

// ClearSessions routes workspace-wide removal through the same runtime-close,
// mutation-actor, atomic canonical delete, and post-commit cleanup coordinator
// as scoped deletion. Service layers must not enumerate or clear sessions on
// their own because doing so creates a second lifecycle authority.
func (h *Host) ClearSessions(ctx context.Context, workspaceID string) (ClearSessionsResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if h == nil || h.sessionBatchManagement == nil || h.runtime == nil || workspaceID == "" {
		return ClearSessionsResult{}, ErrInvalidArgument
	}
	plan, err := h.sessionBatchManagement.PlanClearSessions(ctx, workspaceID)
	if err != nil {
		return ClearSessionsResult{}, err
	}
	if len(plan.SessionIDs) == 0 {
		return ClearSessionsResult{}, nil
	}
	return h.DeleteSessions(ctx, DeleteSessionsInput{
		WorkspaceID: workspaceID,
		SessionIDs:  plan.SessionIDs,
	})
}

func containsSessionID(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func normalizedUniqueSessionIDs(values []string) []string {
	result := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func releaseSessionLocks(releases []func()) {
	for index := len(releases) - 1; index >= 0; index-- {
		if releases[index] != nil {
			releases[index]()
		}
	}
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
