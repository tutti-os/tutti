package agentruntime

import "strings"

// Session commit boundary
// -----------------------
//
// A turn-execution goroutine captures a Session snapshot when its turn begins
// and folds provider events onto that local value while the provider runs.
// Meanwhile the controller's live session may be mutated concurrently by other
// lifecycle commands (SetTitle, SetVisible, UpdateSettings), so the exec-path
// snapshot is never the accepted state. commitTurnExecSessionLocked is the
// single boundary through which those goroutines write back, and it merges only
// the fields turn execution owns. Callers must publish and report using the
// returned accepted session, never the exec-path snapshot.

// mergeTurnExecSession produces the accepted session for a turn-execution
// commit. `current` is the controller's current session (the only accepted
// state); `update` is the turn goroutine's local snapshot. Only
// turn-execution-owned fields are taken from `update`; user-mutated fields
// (Title, Visible, Settings, PermissionModeID) and identity fields are always
// preserved from `current`, so a concurrent SetTitle/SetVisible/UpdateSettings
// can never be lost to a stale exec copy.
func mergeTurnExecSession(current, update Session) (Session, bool) {
	// A stale adapter lifecycle snapshot (already superseded by a newer one
	// applied through the session-event sink) must never regress the accepted
	// session. This lost-update guard previously lived only in storeTurnSession;
	// finishTurn now applies the same rule so settlement cannot resurrect an
	// older lifecycle.
	if current.LifecycleAuthority && current.LifecycleSeq > update.LifecycleSeq {
		return Session{}, false
	}
	accepted := current

	// Turn-execution-owned fields: lifecycle, status, availability, and the
	// event-derived facts only turn execution observes.
	accepted.Status = update.Status
	accepted.TurnLifecycle = cloneRuntimeTurnLifecycle(update.TurnLifecycle)
	accepted.SubmitAvailability = cloneRuntimeSubmitAvailability(update.SubmitAvailability)
	accepted.LastError = update.LastError
	accepted.Resumable = current.Resumable || update.Resumable
	if providerSessionID := strings.TrimSpace(update.ProviderSessionID); providerSessionID != "" {
		accepted.ProviderSessionID = providerSessionID
	}
	if update.UpdatedAtUnixMS > current.UpdatedAtUnixMS {
		accepted.UpdatedAtUnixMS = update.UpdatedAtUnixMS
	}
	if update.LifecycleAuthority {
		accepted.LifecycleAuthority = true
		if update.LifecycleSeq > accepted.LifecycleSeq {
			accepted.LifecycleSeq = update.LifecycleSeq
		}
	}

	// Title ownership: a title the user set explicitly is immutable from the
	// exec path's perspective. A provider/event title is only a candidate while
	// no user title exists; once accepted it is carried into the accepted
	// session without changing the established-title state.
	if current.UserTitleSet {
		accepted.Title = current.Title
	} else if strings.TrimSpace(update.Title) != "" {
		accepted.Title = strings.TrimSpace(update.Title)
	}
	accepted.UserTitleSet = current.UserTitleSet

	accepted.RuntimeContext = mergeTurnExecRuntimeContext(
		current.RuntimeContext,
		update.RuntimeContext,
		accepted.SettingsValue(),
		accepted.InitialTitleEstablished,
	)
	return accepted, true
}

// mergeTurnExecRuntimeContext preserves the accepted runtime context while
// merging event-derived keys from the exec snapshot, then re-asserts the
// settings-derived keys and the initial-title marker from the accepted session
// so a stale exec copy can never clobber concurrent settings or title state.
func mergeTurnExecRuntimeContext(
	current, update map[string]any,
	settings SessionSettings,
	established bool,
) map[string]any {
	merged := clonePayload(current)
	if merged == nil {
		merged = map[string]any{}
	}
	if len(update) > 0 {
		merged = mergeRuntimeContextPatch(merged, update)
	}
	merged = runtimeContextWithSessionSettings(merged, settings)
	return runtimeContextWithInitialTitleEstablished(merged, established)
}

// commitTurnExecSessionLocked validates the turn fence, applies the merge onto
// the controller's current session, optionally settles the turn, and persists
// the accepted session. When settle is true the matched turn fence is always
// removed — even if the merge rejects the write (different live turn, newer
// adapter lifecycle, closed session) — because a stale exec snapshot must not
// keep the fence open.
func (c *Controller) commitTurnExecSessionLocked(key, turnID string, update Session, settle bool) (Session, bool) {
	active, ok := c.turns[key]
	if !ok || strings.TrimSpace(active.turnID) != strings.TrimSpace(turnID) {
		return Session{}, false
	}
	if settle {
		delete(c.turns, key)
	}
	current, ok := c.sessions[key]
	if !ok {
		return Session{}, false
	}
	if settle && sessionHasDifferentLiveTurn(current, turnID) {
		return Session{}, false
	}
	accepted, ok := mergeTurnExecSession(current, update)
	if !ok {
		return Session{}, false
	}
	if settle && !accepted.LifecycleAuthority {
		// ADR 0008: snapshot-authority sessions already settle through their own
		// copied lifecycle; legacy sessions get the controller-origin settle and
		// a pure status reconcile.
		accepted = settleFinishedTurnLifecycle(accepted, turnID)
		accepted = c.reconcileSessionStatusLocked(key, accepted)
	}
	c.sessions[key] = accepted
	return accepted, true
}
