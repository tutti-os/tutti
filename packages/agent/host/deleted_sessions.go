package agenthost

import (
	"context"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type PurgeDeletedSessionsInput struct {
	CutoffUnixMS    int64
	MaxSessions     int
	MaxPayloadBytes int64
}

type PurgeDeletedSessionsResult struct {
	Sessions        []storesqlite.PurgedSession
	RemovedMessages int
	PayloadBytes    int64
	HasMore         bool
}

type ListDeletedSessionsInput struct {
	WorkspaceID           string
	SearchQuery           string
	RailSectionKey        *string
	CursorUpdatedAtUnixMS int64
	CursorAgentSessionID  string
	Limit                 int
}

type DeletedSessionSummary = storesqlite.DeletedSessionSummary

const (
	DeletedSessionUnavailableLegacyData     = storesqlite.DeletedSessionUnavailableLegacyData
	DeletedSessionUnavailableIncompleteTree = storesqlite.DeletedSessionUnavailableIncompleteTree
)

type DeletedSessionPage struct {
	WorkspaceID         string
	Sessions            []DeletedSessionSummary
	RailSections        []storesqlite.DeletedSessionRailSection
	TotalCount          int
	WorkspaceTotalCount int
	HasMore             bool
	NextCursor          string
}

type RestoreDeletedSessionInput struct {
	WorkspaceID    string
	AgentSessionID string
}

type RestoreDeletedSessionResult struct {
	Restored           bool
	RestoredSessionIDs []string
}

type PurgeDeletedSessionTreesInput struct {
	WorkspaceID    string
	RootSessionIDs []string
}

type PurgeDeletedSessionTreesResult struct {
	PurgedRootSessionIDs []string
	PurgedSessionIDs     []string
	RemovedSessions      int
	RemovedMessages      int
	PayloadBytes         int64
}

// ListDeletedSessions reads only canonical tombstones and never prepares or
// resumes a provider runtime.
func (h *Host) ListDeletedSessions(ctx context.Context, input ListDeletedSessionsInput) (DeletedSessionPage, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if h == nil || h.deletedSessions == nil || workspaceID == "" {
		return DeletedSessionPage{}, ErrInvalidArgument
	}
	var railSectionKey *string
	if input.RailSectionKey != nil {
		value := strings.TrimSpace(*input.RailSectionKey)
		if value == "" {
			return DeletedSessionPage{}, ErrInvalidArgument
		}
		railSectionKey = &value
	}
	page, err := h.deletedSessions.ListDeletedSessions(ctx, storesqlite.ListDeletedSessionsInput{
		WorkspaceID: workspaceID, SearchQuery: input.SearchQuery, RailSectionKey: railSectionKey,
		CursorUpdatedAtUnixMS: input.CursorUpdatedAtUnixMS,
		CursorAgentSessionID:  input.CursorAgentSessionID, Limit: input.Limit,
	})
	if err != nil {
		return DeletedSessionPage{}, err
	}
	return DeletedSessionPage{
		WorkspaceID: page.WorkspaceID, Sessions: page.Sessions,
		RailSections: page.RailSections, TotalCount: page.TotalCount,
		WorkspaceTotalCount: page.WorkspaceTotalCount,
		HasMore:             page.HasMore, NextCursor: page.NextCursor,
	}, nil
}

// RestoreDeletedSession atomically restores one complete topmost deleted
// component. Its anchor may be a root Session or a child subtree. It
// deliberately does not prepare, start, or resume a provider runtime; a later
// explicit user action enters the ordinary resume policy.
func (h *Host) RestoreDeletedSession(ctx context.Context, input RestoreDeletedSessionInput) (RestoreDeletedSessionResult, error) {
	ref := normalizedSessionRef(SessionRef(input))
	if h == nil || h.deletedSessions == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return RestoreDeletedSessionResult{}, ErrInvalidArgument
	}
	var result storesqlite.RestoreDeletedSessionResult
	err := h.withSessionMutationActors(ctx, ref.WorkspaceID, []string{ref.AgentSessionID}, func(commandCtx context.Context) error {
		release, err := h.acquireSession(commandCtx, ref)
		if err != nil {
			return err
		}
		defer release()
		result, err = h.deletedSessions.RestoreDeletedSession(commandCtx, storesqlite.RestoreDeletedSessionInput{
			WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		})
		return err
	})
	if err != nil {
		return RestoreDeletedSessionResult{}, err
	}
	return RestoreDeletedSessionResult{
		Restored:           result.Restored,
		RestoredSessionIDs: copySessionIDs(result.RestoredSessionIDs),
	}, nil
}

// PurgeDeletedSessionTrees permanently removes selected topmost deleted
// components, or every such component in a workspace when RootSessionIDs is
// empty. The compatibility field may identify a root or child anchor. Runtime
// and filesystem cleanup policy remains adapter-owned and occurs after this
// canonical commit.
func (h *Host) PurgeDeletedSessionTrees(ctx context.Context, input PurgeDeletedSessionTreesInput) (PurgeDeletedSessionTreesResult, error) {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	if h == nil || h.deletedSessions == nil || workspaceID == "" {
		return PurgeDeletedSessionTreesResult{}, ErrInvalidArgument
	}
	result, err := h.deletedSessions.PurgeDeletedSessionTrees(ctx, storesqlite.PurgeDeletedSessionTreesInput{
		WorkspaceID: workspaceID, RootSessionIDs: normalizedUniqueSessionIDs(input.RootSessionIDs),
	})
	if err != nil {
		return PurgeDeletedSessionTreesResult{}, err
	}
	return PurgeDeletedSessionTreesResult{
		PurgedRootSessionIDs: copySessionIDs(result.PurgedRootSessionIDs),
		PurgedSessionIDs:     copySessionIDs(result.PurgedSessionIDs),
		RemovedSessions:      result.RemovedSessions, RemovedMessages: result.RemovedMessages,
		PayloadBytes: result.PayloadBytes,
	}, nil
}
