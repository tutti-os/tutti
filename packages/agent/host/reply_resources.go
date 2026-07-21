package agenthost

import (
	"context"
	"errors"
	"strings"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// AttachReplyResource binds an already-immutable resource reference to the
// canonical active turn. The store performs the active-turn check and insert
// atomically, so a late tool call cannot leak into the next turn.
func (h *Host) AttachReplyResource(ctx context.Context, ref SessionRef, input AttachReplyResourceInput) (AttachReplyResourceResult, error) {
	ref = normalizedSessionRef(ref)
	input = normalizeAttachReplyResourceInput(input)
	if h == nil || h.replyResources == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" ||
		input.TurnID == "" || input.ResourceID == "" || input.DedupeKey == "" || input.SourceRef == "" || input.DisplayName == "" ||
		input.SizeBytes < 0 || (input.Kind != storesqlite.ReplyResourceKindLocalFile && input.Kind != storesqlite.ReplyResourceKindExternalArtifact) {
		return AttachReplyResourceResult{}, ErrInvalidArgument
	}
	if input.CreatedAtUnixMS <= 0 {
		input.CreatedAtUnixMS = time.Now().UnixMilli()
	}
	resource, created, err := h.replyResources.AttachReplyResourceToActiveTurn(ctx, storesqlite.AttachReplyResourceInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, TurnID: input.TurnID,
		ResourceID: input.ResourceID, DedupeKey: input.DedupeKey, Kind: input.Kind,
		SourceRef: input.SourceRef, ContentHash: input.ContentHash, DisplayName: input.DisplayName,
		MediaType: input.MediaType, SizeBytes: input.SizeBytes, CreatedAtUnixMS: input.CreatedAtUnixMS,
	})
	if errors.Is(err, storesqlite.ErrNoActiveTurn) {
		return AttachReplyResourceResult{}, ErrNoActiveTurn
	}
	if err != nil {
		return AttachReplyResourceResult{}, err
	}
	return AttachReplyResourceResult{Resource: resource, Created: created}, nil
}

func (h *Host) ListTurnReplyResources(ctx context.Context, ref SessionRef, turnID string) ([]storesqlite.ReplyResource, error) {
	ref = normalizedSessionRef(ref)
	turnID = strings.TrimSpace(turnID)
	if h == nil || h.replyResources == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || turnID == "" {
		return nil, ErrInvalidArgument
	}
	return h.replyResources.ListTurnReplyResources(ctx, ref.WorkspaceID, ref.AgentSessionID, turnID)
}

func normalizeAttachReplyResourceInput(input AttachReplyResourceInput) AttachReplyResourceInput {
	input.TurnID = strings.TrimSpace(input.TurnID)
	input.ResourceID = strings.TrimSpace(input.ResourceID)
	input.DedupeKey = strings.TrimSpace(input.DedupeKey)
	input.Kind = strings.TrimSpace(input.Kind)
	input.SourceRef = strings.TrimSpace(input.SourceRef)
	input.ContentHash = strings.TrimSpace(input.ContentHash)
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.MediaType = strings.TrimSpace(input.MediaType)
	return input
}
