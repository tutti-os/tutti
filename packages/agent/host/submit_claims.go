package agenthost

import (
	"context"
	"strings"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func clientSubmitID(metadata map[string]any) string {
	value, _ := metadata["clientSubmitId"].(string)
	return strings.TrimSpace(value)
}

func (h *Host) prepareSubmitClaim(ctx context.Context, ref SessionRef, metadata map[string]any) (storesqlite.SubmitClaim, bool, error) {
	clientID := clientSubmitID(metadata)
	if h == nil || h.store == nil || clientID == "" {
		return storesqlite.SubmitClaim{}, false, nil
	}
	return h.store.PrepareSubmitClaim(ctx, storesqlite.SubmitClaimPrepare{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		ClientSubmitID: clientID, NowUnixMS: h.now().UnixMilli(),
	})
}

func (h *Host) abandonSubmitClaim(ref SessionRef, clientID string) {
	if h == nil || h.store == nil || strings.TrimSpace(clientID) == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = h.store.DeleteSubmitClaim(ctx, ref.WorkspaceID, ref.AgentSessionID, clientID)
}

func (h *Host) acceptSubmitClaim(ref SessionRef, clientID, turnID string) error {
	if h == nil || h.store == nil || strings.TrimSpace(clientID) == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := h.store.AcceptSubmitClaim(ctx, ref.WorkspaceID, ref.AgentSessionID, clientID, turnID, h.now().UnixMilli())
	return err
}
