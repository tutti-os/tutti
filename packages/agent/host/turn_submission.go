package agenthost

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (h *Host) recordTurnSubmission(
	ctx context.Context,
	ref SessionRef,
	turnID string,
	clientSubmitID string,
	content []PromptContentBlock,
	displayPrompt string,
	capabilityRefs []CapabilityReference,
	metadata map[string]any,
	tuttiModeSnapshot *TuttiModeTurnSnapshot,
) error {
	if h == nil || h.turnSubmissions == nil {
		return nil
	}
	contentJSON, err := json.Marshal(content)
	if err != nil {
		return fmt.Errorf("encode turn submission content: %w", err)
	}
	capabilityRefsJSON, err := json.Marshal(capabilityRefs)
	if err != nil {
		return fmt.Errorf("encode turn submission capability refs: %w", err)
	}
	metadataJSON := []byte("{}")
	if len(metadata) > 0 {
		metadataJSON, err = json.Marshal(metadata)
		if err != nil {
			return fmt.Errorf("encode turn submission metadata: %w", err)
		}
	}
	tuttiModeSnapshotJSON, err := json.Marshal(tuttiModeSnapshot)
	if err != nil {
		return fmt.Errorf("encode turn submission tutti mode snapshot: %w", err)
	}
	now := h.now().UnixMilli()
	_, _, err = h.turnSubmissions.RecordTurnSubmission(ctx, storesqlite.TurnSubmission{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		TurnID: strings.TrimSpace(turnID), ContentJSON: string(contentJSON),
		DisplayPrompt:         strings.TrimSpace(displayPrompt),
		CapabilityRefsJSON:    string(capabilityRefsJSON),
		TuttiModeSnapshotJSON: string(tuttiModeSnapshotJSON),
		MetadataJSON:          string(metadataJSON),
		ClientSubmitID:        strings.TrimSpace(clientSubmitID),
		CreatedAtUnixMS:       now, UpdatedAtUnixMS: now,
	})
	if err != nil {
		return fmt.Errorf("record turn submission envelope: %w", err)
	}
	return nil
}
