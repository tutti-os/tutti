package agenthost

import (
	"context"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// replayInitialGoalCreate projects one durable Goal-operation replay back into
// the CreateSession result without performing runtime preparation or startup.
func (h *Host) replayInitialGoalCreate(
	ctx context.Context,
	input CreateSessionInput,
	goalInput GoalControlInput,
) (CreateSessionResult, bool, error) {
	replay, found, err := h.existingGoalControlResult(ctx, goalInput)
	if !found {
		return CreateSessionResult{}, found, nil
	}
	if err != nil && !goalControlResultPending(replay) {
		result, resultErr := createSessionFailureResult(input, err)
		return result, true, resultErr
	}
	if strings.TrimSpace(replay.Canonical.ID) == "" {
		canonical, sessionFound, readErr := h.store.GetSession(ctx, goalInput.WorkspaceID, goalInput.AgentSessionID)
		if readErr != nil || !sessionFound {
			if readErr == nil {
				readErr = ErrSessionNotFound
			}
			result, resultErr := createSessionFailureResult(input, readErr)
			return result, true, resultErr
		}
		replay.Canonical = canonical
	}
	if !railPlacementMatchesSession(input.RailPlacement, replay.Canonical) {
		result, resultErr := createSessionFailureResult(input, ErrRailPlacementConflict)
		return result, true, resultErr
	}
	runtimeSession, live := h.runtime.Session(goalInput.WorkspaceID, input.AgentSessionID)
	if !live {
		runtimeSession = providerRuntimeSessionIdentity(replay.Canonical)
	}
	initialGoalStatus := CreateSessionInitialGoalStatusSucceeded
	if err != nil {
		initialGoalStatus = CreateSessionInitialGoalStatusUnknown
	}
	return CreateSessionResult{
		Session: runtimeSession, Canonical: replay.Canonical,
		Kind: "goalControl", GoalControl: &replay,
		SessionStatus:     CreateSessionStatusCreated,
		InitialGoalStatus: initialGoalStatus,
	}, true, err
}

func providerRuntimeSessionIdentity(session storesqlite.Session) ProviderRuntimeSession {
	return ProviderRuntimeSession{
		ID:                strings.TrimSpace(session.ID),
		WorkspaceID:       strings.TrimSpace(session.WorkspaceID),
		UserID:            strings.TrimSpace(session.UserID),
		AgentTargetID:     strings.TrimSpace(session.AgentTargetID),
		Provider:          strings.TrimSpace(session.Provider),
		ProviderSessionID: strings.TrimSpace(session.ProviderSessionID),
		Cwd:               strings.TrimSpace(session.Cwd),
		Visible:           session.Metadata.Visible,
		Title:             strings.TrimSpace(session.Title),
		PinnedAtUnixMS:    session.PinnedAtUnixMS,
		CreatedAtUnixMS:   session.CreatedAtUnixMS,
		UpdatedAtUnixMS:   session.UpdatedAtUnixMS,
	}
}
