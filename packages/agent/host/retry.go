package agenthost

import (
	"context"
	"strings"

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
		Content: userContent,
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
		text := ""
		if msg.Payload != nil {
			if v, ok := msg.Payload["text"].(string); ok {
				text = v
			} else if v, ok := msg.Payload["content"].(string); ok {
				text = v
			}
		}
		if strings.TrimSpace(text) == "" {
			continue
		}
		return []PromptContentBlock{{Type: "text", Text: text}}, nil
	}
	return nil, ErrTurnNoUserMessage
}
