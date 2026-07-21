package agenthost

import (
	"context"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// GetTurn exposes canonical turn truth without requiring Host consumers to
// retain or type-assert the concrete store used by the Host adapter.
func (h *Host) GetTurn(ctx context.Context, ref SessionRef, turnID string) (storesqlite.Turn, bool, error) {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	turnID = strings.TrimSpace(turnID)
	if h == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || turnID == "" {
		return storesqlite.Turn{}, false, ErrInvalidArgument
	}
	return h.store.GetTurn(ctx, ref.WorkspaceID, ref.AgentSessionID, turnID)
}

// FindTurnByClientSubmitID exposes the canonical idempotency lookup without
// requiring callers to depend on a concrete SQLite store.
func (h *Host) FindTurnByClientSubmitID(ctx context.Context, ref SessionRef, clientSubmitID string) (string, bool, error) {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	clientSubmitID = strings.TrimSpace(clientSubmitID)
	if h == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || clientSubmitID == "" {
		return "", false, ErrInvalidArgument
	}
	return h.store.FindTurnByClientSubmitID(ctx, ref.WorkspaceID, ref.AgentSessionID, clientSubmitID)
}

// ListSessionMessages reads one version-cursor page of canonical message
// snapshots without starting or resuming a provider runtime. Session identity
// is carried only by SessionRef; the query owns filters and pagination.
func (h *Host) ListSessionMessages(ctx context.Context, ref SessionRef, query SessionMessageQuery) (storesqlite.MessagePage, bool, error) {
	ref = normalizedSessionRef(ref)
	if h == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return storesqlite.MessagePage{}, false, ErrInvalidArgument
	}
	return h.store.ListSessionMessages(ctx, storesqlite.ListSessionMessagesInput{
		WorkspaceID:    ref.WorkspaceID,
		AgentSessionID: ref.AgentSessionID,
		MessageID:      strings.TrimSpace(query.MessageID),
		TurnID:         strings.TrimSpace(query.TurnID),
		AfterVersion:   query.AfterVersion,
		BeforeVersion:  query.BeforeVersion,
		Limit:          query.Limit,
		Order:          query.Order,
	})
}

// GetSessionInteractionSnapshot returns every interaction from the canonical
// latest turn and derives the actionable subset from that same read. It does
// not start or resume a provider runtime.
func (h *Host) GetSessionInteractionSnapshot(ctx context.Context, ref SessionRef) (SessionInteractionSnapshot, error) {
	ref = normalizedSessionRef(ref)
	if h == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return SessionInteractionSnapshot{}, ErrInvalidArgument
	}
	if deleted, err := h.store.SessionDeleted(ctx, ref.WorkspaceID, ref.AgentSessionID); err != nil {
		return SessionInteractionSnapshot{}, err
	} else if deleted {
		return SessionInteractionSnapshot{}, ErrSessionNotFound
	}
	if _, found, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID); err != nil {
		return SessionInteractionSnapshot{}, err
	} else if !found {
		return SessionInteractionSnapshot{}, ErrSessionNotFound
	}

	bySession, err := h.store.ListLatestTurnInteractions(ctx, ref.WorkspaceID, []string{ref.AgentSessionID})
	if err != nil {
		return SessionInteractionSnapshot{}, err
	}
	interactions := append([]storesqlite.Interaction(nil), bySession[ref.AgentSessionID]...)
	pending := make([]storesqlite.Interaction, 0, len(interactions))
	for _, interaction := range interactions {
		if interaction.Status == storesqlite.InteractionStatusPending {
			pending = append(pending, interaction)
		}
	}
	return SessionInteractionSnapshot{Interactions: interactions, PendingInteractions: pending}, nil
}
