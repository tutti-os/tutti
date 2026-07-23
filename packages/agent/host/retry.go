package agenthost

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// RetryTurn creates a new Turn in the same Session that retries the user input
// from a previous settled Turn. The new Turn records parent_turn_id and
// relation="retry" via TurnLineage, flowing through the existing SendInput ->
// Runtime Exec -> Turn persistence pipeline.
//
// RetryTurn does NOT:
//   - create a Child Session
//   - replay or rebuild Provider LLM context
//   - modify the original Turn or any historical messages
//   - copy Assistant messages or Tool Calls
func (h *Host) RetryTurn(ctx context.Context, ref SessionRef, turnID string) (SendInputResult, error) {
	return h.createDerivedTurn(ctx, ref, turnID, TurnRelationRetry)
}

// createDerivedTurn is the shared internal entry point for Retry/Edit/Fork:
// it validates the parent turn, extracts the original user input, and calls
// SendInput with TurnLineage metadata. Future Edit/Bfork callers will reuse
// this path with a different relation value and (optionally) overridden content.
func (h *Host) createDerivedTurn(ctx context.Context, ref SessionRef, parentTurnID string, relation TurnRelation) (SendInputResult, error) {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	parentTurnID = strings.TrimSpace(parentTurnID)
	if h == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || parentTurnID == "" {
		return SendInputResult{}, ErrInvalidArgument
	}

	turn, found, err := h.store.GetTurn(ctx, ref.WorkspaceID, ref.AgentSessionID, parentTurnID)
	if err != nil {
		return SendInputResult{}, err
	}
	if !found {
		return SendInputResult{}, ErrTurnNotFound
	}
	if turn.Phase != storesqlite.TurnPhaseSettled {
		return SendInputResult{}, ErrTurnNotSettled
	}

	userContent, err := h.findTurnUserMessageContent(ctx, ref, parentTurnID)
	if err != nil {
		return SendInputResult{}, err
	}

	return h.SendInput(ctx, ref, SendInput{
		Content:        userContent,
		TurnID:         derivedTurnID(ref, parentTurnID, relation),
		ClientSubmitID: derivedTurnClientSubmitID(ref, parentTurnID, relation),
		TurnLineage: &TurnLineage{
			ParentTurnID: parentTurnID,
			Relation:     relation,
		},
	})
}

// findTurnUserMessageContent loads the user text message for a specific Turn
// (filtered by TurnID) and reconstructs PromptContentBlock from its stored
// payload. The TurnID filter ensures multi-turn sessions return the correct
// turn's input, not a different turn's user message.
func (h *Host) findTurnUserMessageContent(ctx context.Context, ref SessionRef, turnID string) ([]PromptContentBlock, error) {
	page, _, err := h.store.ListSessionMessages(ctx, storesqlite.ListSessionMessagesInput{
		WorkspaceID:    ref.WorkspaceID,
		AgentSessionID: ref.AgentSessionID,
		TurnID:         turnID,
		Limit:          100,
		Order:          storesqlite.MessageOrderAsc,
	})
	if err != nil {
		return nil, err
	}
	for _, msg := range page.Messages {
		if strings.TrimSpace(msg.Role) != "user" {
			continue
		}
		if content, present := msg.Payload["content"]; present {
			if text, ok := content.(string); ok {
				if legacy := legacyPromptContent(text); legacy != nil {
					return legacy, nil
				}
				continue
			}
			return promptContentFromActivityPayload(content)
		}
		if text, ok := msg.Payload["text"].(string); ok {
			if legacy := legacyPromptContent(text); legacy != nil {
				return legacy, nil
			}
			continue
		}
	}
	return nil, ErrTurnNoUserMessage
}

// promptContentFromActivityPayload decodes the canonical activity payload
// produced from PromptContentBlock. It intentionally validates through the
// Host's prompt normalizer so recovered content follows the same contract as a
// fresh submit rather than maintaining a second activity-content protocol.
func promptContentFromActivityPayload(value any) ([]PromptContentBlock, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("%w: encode structured content: %v", ErrTurnPromptUnrecoverable, err)
	}
	var content []PromptContentBlock
	if err := json.Unmarshal(raw, &content); err != nil {
		return nil, fmt.Errorf("%w: decode structured content: %v", ErrTurnPromptUnrecoverable, err)
	}
	normalized, _, err := normalizePromptContent(content)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid structured content", ErrTurnPromptUnrecoverable)
	}
	return normalized, nil
}

func legacyPromptContent(text string) []PromptContentBlock {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	return []PromptContentBlock{{Type: "text", Text: text}}
}

func derivedTurnID(ref SessionRef, parentTurnID string, relation TurnRelation) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(strings.Join([]string{
		"tutti", "derived-turn", strings.TrimSpace(ref.WorkspaceID), strings.TrimSpace(ref.AgentSessionID),
		strings.TrimSpace(parentTurnID), string(relation),
	}, "\x00"))).String()
}

func derivedTurnClientSubmitID(ref SessionRef, parentTurnID string, relation TurnRelation) string {
	return "derived-turn:" + derivedTurnID(ref, parentTurnID, relation)
}

func (h *Host) validateTurnLineage(ctx context.Context, ref SessionRef, turnID string, lineage *TurnLineage) (*TurnLineage, error) {
	if lineage == nil {
		return nil, nil
	}
	normalized := &TurnLineage{
		ParentTurnID: strings.TrimSpace(lineage.ParentTurnID),
		Relation:     TurnRelation(strings.TrimSpace(string(lineage.Relation))),
	}
	if normalized.ParentTurnID == "" || normalized.Relation == "" ||
		(normalized.Relation != TurnRelationRetry && normalized.Relation != TurnRelationEdit) ||
		normalized.ParentTurnID == strings.TrimSpace(turnID) {
		return nil, ErrInvalidTurnLineage
	}
	parent, found, err := h.store.GetTurn(ctx, ref.WorkspaceID, ref.AgentSessionID, normalized.ParentTurnID)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrTurnNotFound
	}
	if parent.Phase != storesqlite.TurnPhaseSettled {
		return nil, ErrTurnNotSettled
	}
	return normalized, nil
}
