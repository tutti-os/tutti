package agenthost

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func legacyClientSubmitID(metadata map[string]any) string {
	value, _ := metadata["clientSubmitId"].(string)
	return strings.TrimSpace(value)
}

func submissionMetadata(metadata map[string]any, typedClientSubmitID string) map[string]any {
	clientID := strings.TrimSpace(typedClientSubmitID)
	if clientID == "" {
		return metadata
	}
	result := cloneMap(metadata)
	if result == nil {
		result = make(map[string]any, 1)
	}
	result["clientSubmitId"] = clientID
	return result
}

// submitClaimMetadataJSON deliberately persists only the closed analytics
// provenance needed before provider dispatch. Submit claims are long-lived;
// copying the full submission metadata here would expand both storage and the
// privacy surface of this admission fence.
func submitClaimMetadataJSON(metadata map[string]any) (string, error) {
	claimMetadata := make(map[string]any, 1)
	if mode, ok := metadata["uiMode"].(string); ok && (mode == "os" || mode == "agent") {
		claimMetadata["uiMode"] = mode
	}
	encoded, err := json.Marshal(claimMetadata)
	if err != nil {
		return "", fmt.Errorf("encode submit claim metadata: %w", err)
	}
	return string(encoded), nil
}

func (h *Host) prepareSubmitClaim(ctx context.Context, ref SessionRef, metadata map[string]any, canonicalTurnID string) (storesqlite.SubmitClaim, bool, error) {
	clientID := legacyClientSubmitID(metadata)
	if h == nil || h.store == nil || clientID == "" {
		return storesqlite.SubmitClaim{}, false, nil
	}
	metadataJSON, err := submitClaimMetadataJSON(metadata)
	if err != nil {
		return storesqlite.SubmitClaim{}, false, err
	}
	claim, created, err := h.store.PrepareSubmitClaim(ctx, storesqlite.SubmitClaimPrepare{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		ClientSubmitID: clientID, CanonicalTurnID: strings.TrimSpace(canonicalTurnID),
		MetadataJSON: metadataJSON, NowUnixMS: h.now().UnixMilli(),
	})
	if err != nil || created || claim.Status != "prepared" {
		return claim, created, err
	}
	turnID, found, err := h.store.FindTurnByClientSubmitID(ctx, ref.WorkspaceID, ref.AgentSessionID, clientID)
	if err != nil || !found {
		return claim, false, err
	}
	if strings.TrimSpace(turnID) != strings.TrimSpace(claim.CanonicalTurnID) {
		return claim, false, storesqlite.ErrSubmitClaimTurnConflict
	}
	claim, _, err = h.store.AcceptSubmitClaim(
		ctx, ref.WorkspaceID, ref.AgentSessionID, clientID, turnID, h.now().UnixMilli(),
	)
	return claim, false, err
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

func (h *Host) rejectSubmitClaim(ref SessionRef, clientID, turnID string) error {
	if h == nil || h.store == nil || strings.TrimSpace(clientID) == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := h.store.RejectSubmitClaim(ctx, ref.WorkspaceID, ref.AgentSessionID, clientID, turnID, h.now().UnixMilli())
	return err
}

func (h *Host) finalizeRejectedSubmitClaim(ref SessionRef, clientID, turnID string) error {
	if strings.TrimSpace(turnID) == "" {
		return nil
	}
	return h.rejectSubmitClaim(ref, clientID, turnID)
}

func (h *Host) replayedSubmitResult(ctx context.Context, ref SessionRef, claim storesqlite.SubmitClaim) (SendInputResult, error) {
	canonicalSession, ok, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return SendInputResult{}, err
	}
	if !ok {
		if _, live := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID); !live {
			return SendInputResult{}, ErrSessionNotFound
		}
	}
	turn, ok, err := h.store.GetTurn(ctx, ref.WorkspaceID, ref.AgentSessionID, claim.TurnID)
	if err != nil {
		return SendInputResult{}, err
	}
	if !ok {
		return SendInputResult{}, ErrSubmitDeliveryUnknown
	}
	live, _ := h.runtime.Session(ref.WorkspaceID, ref.AgentSessionID)
	availability := SubmitAvailability{State: "available"}
	if strings.TrimSpace(canonicalSession.ActiveTurnID) != "" {
		availability = SubmitAvailability{State: "blocked", Reason: "active_turn"}
	}
	return SendInputResult{
		Session: live, Canonical: canonicalSession, Turn: &turn, TurnID: claim.TurnID,
		TurnLifecycle: lifecycleFromTurn(turn), SubmitAvailability: availability,
	}, nil
}
