package agenthost

import (
	"context"
	"errors"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// retryMockStore implements just enough of CanonicalStore for RetryTurn
// validation-path tests. The success path (SendInput) is not exercised here;
// it requires a fully wired Host and is covered by integration tests.
type retryMockStore struct {
	turn      storesqlite.Turn
	turnFound bool
	turnErr   error
	messages  storesqlite.MessagePage
	msgFound  bool
	msgErr    error
	// Captures the TurnID passed to ListSessionMessages for multi-turn
	// isolation verification.
	capturedTurnID string
}

func (s *retryMockStore) GetTurn(_ context.Context, _, _, _ string) (storesqlite.Turn, bool, error) {
	return s.turn, s.turnFound, s.turnErr
}

func (s *retryMockStore) ListSessionMessages(_ context.Context, input storesqlite.ListSessionMessagesInput) (storesqlite.MessagePage, bool, error) {
	s.capturedTurnID = input.TurnID
	return s.messages, s.msgFound, s.msgErr
}

// Stubs for the rest of CanonicalStore — not called in validation paths.
func (s retryMockStore) GetSession(context.Context, string, string) (storesqlite.Session, bool, error) {
	return storesqlite.Session{}, false, nil
}
func (s retryMockStore) SessionDeleted(context.Context, string, string) (bool, error) {
	return false, nil
}
func (s retryMockStore) RollbackRuntimeSessionInitialization(context.Context, string, string) (bool, error) {
	return false, nil
}
func (s retryMockStore) InitializeRuntimeSession(context.Context, ProviderRuntimeSession) (storesqlite.Session, error) {
	return storesqlite.Session{}, nil
}
func (s retryMockStore) UpdateSessionTitle(context.Context, string, string, string) (storesqlite.Session, bool, error) {
	return storesqlite.Session{}, false, nil
}
func (s retryMockStore) ListChildSessions(context.Context, string, string) ([]storesqlite.Session, error) {
	return nil, nil
}
func (s retryMockStore) FindTurnByClientSubmitID(context.Context, string, string, string) (string, bool, error) {
	return "", false, nil
}
func (s retryMockStore) ListLatestTurnInteractions(context.Context, string, []string) (map[string][]storesqlite.Interaction, error) {
	return nil, nil
}
func (s retryMockStore) ListSessionInteractions(context.Context, storesqlite.ListSessionInteractionsInput) ([]storesqlite.Interaction, error) {
	return nil, nil
}
func (s retryMockStore) PrepareSubmitClaim(context.Context, storesqlite.SubmitClaimPrepare) (storesqlite.SubmitClaim, bool, error) {
	return storesqlite.SubmitClaim{}, false, nil
}
func (s retryMockStore) AcceptSubmitClaim(context.Context, string, string, string, string, int64) (storesqlite.SubmitClaim, bool, error) {
	return storesqlite.SubmitClaim{}, false, nil
}
func (s retryMockStore) DeleteSubmitClaim(context.Context, string, string, string) (bool, error) {
	return false, nil
}

func newRetryTestHost(store CanonicalStore) *Host {
	return &Host{store: store}
}

func TestRetryTurnRejectsEmptyArguments(t *testing.T) {
	host := newRetryTestHost(&retryMockStore{})
	_, err := host.RetryTurn(context.Background(), SessionRef{}, "")
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("RetryTurn(empty) error = %v, want ErrInvalidArgument", err)
	}
}

func TestRetryTurnRejectsMissingTurn(t *testing.T) {
	host := newRetryTestHost(&retryMockStore{turnFound: false})
	_, err := host.RetryTurn(context.Background(), SessionRef{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
	}, "turn-missing")
	if !errors.Is(err, ErrTurnNotFound) {
		t.Fatalf("RetryTurn(missing) error = %v, want ErrTurnNotFound", err)
	}
}

func TestRetryTurnRejectsUnsettledTurn(t *testing.T) {
	host := newRetryTestHost(&retryMockStore{
		turnFound: true,
		turn: storesqlite.Turn{
			WorkspaceID: "ws-1", AgentSessionID: "session-1",
			TurnID: "turn-running", Phase: storesqlite.TurnPhaseRunning,
		},
	})
	_, err := host.RetryTurn(context.Background(), SessionRef{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
	}, "turn-running")
	if !errors.Is(err, ErrTurnNotSettled) {
		t.Fatalf("RetryTurn(running) error = %v, want ErrTurnNotSettled", err)
	}
}

func TestRetryTurnRejectsSettledTurnWithoutUserMessage(t *testing.T) {
	host := newRetryTestHost(&retryMockStore{
		turnFound: true,
		turn: storesqlite.Turn{
			WorkspaceID: "ws-1", AgentSessionID: "session-1",
			TurnID: "turn-settled", Phase: storesqlite.TurnPhaseSettled,
		},
		messages: storesqlite.MessagePage{
			Messages: []storesqlite.Message{
				{Role: "assistant", Payload: map[string]any{"text": "response"}},
			},
		},
		msgFound: true,
	})
	_, err := host.RetryTurn(context.Background(), SessionRef{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
	}, "turn-settled")
	if !errors.Is(err, ErrTurnNoUserMessage) {
		t.Fatalf("RetryTurn(no-user-msg) error = %v, want ErrTurnNoUserMessage", err)
	}
}

func TestRetryTurnFindUserMessageExtractsText(t *testing.T) {
	// Verify findTurnUserMessageContent correctly extracts user text from
	// stored message payload. This is the core logic that feeds SendInput.
	host := newRetryTestHost(&retryMockStore{
		turnFound: true,
		turn: storesqlite.Turn{
			WorkspaceID: "ws-1", AgentSessionID: "session-1",
			TurnID: "turn-ok", Phase: storesqlite.TurnPhaseSettled,
		},
		messages: storesqlite.MessagePage{
			Messages: []storesqlite.Message{
				{Role: "assistant", Payload: map[string]any{"text": "hello answer"}},
				{Role: "user", Payload: map[string]any{"text": "original question"}},
				{Role: "user", Payload: map[string]any{"content": "fallback content field"}},
			},
		},
		msgFound: true,
	})
	content, err := host.findTurnUserMessageContent(context.Background(), SessionRef{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
	}, "turn-ok")
	if err != nil {
		t.Fatalf("findTurnUserMessageContent error = %v", err)
	}
	if len(content) != 1 {
		t.Fatalf("content length = %d, want 1", len(content))
	}
	if content[0].Text != "original question" {
		t.Fatalf("content[0].Text = %q, want %q", content[0].Text, "original question")
	}
	if content[0].Type != "text" {
		t.Fatalf("content[0].Type = %q, want %q", content[0].Type, "text")
	}
}

func TestRetryTurnFindUserMessageFallsBackToContentField(t *testing.T) {
	host := newRetryTestHost(&retryMockStore{
		messages: storesqlite.MessagePage{
			Messages: []storesqlite.Message{
				{Role: "user", Payload: map[string]any{"content": "fallback text"}},
			},
		},
		msgFound: true,
	})
	content, err := host.findTurnUserMessageContent(context.Background(), SessionRef{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
	}, "turn-x")
	if err != nil {
		t.Fatalf("findTurnUserMessageContent error = %v", err)
	}
	if content[0].Text != "fallback text" {
		t.Fatalf("content[0].Text = %q, want %q", content[0].Text, "fallback text")
	}
}

// TestRetryTurnPassesCorrectTurnIDToMessageQuery verifies that RetryTurn
// queries messages for the SPECIFIC turn being retried, not the entire
// session. This prevents multi-turn sessions from returning the wrong
// user message.
func TestRetryTurnPassesCorrectTurnIDToMessageQuery(t *testing.T) {
	store := &retryMockStore{
		turnFound: true,
		turn: storesqlite.Turn{
			WorkspaceID: "ws-1", AgentSessionID: "session-1",
			TurnID: "turn-2", Phase: storesqlite.TurnPhaseSettled,
		},
		messages: storesqlite.MessagePage{
			Messages: []storesqlite.Message{
				{Role: "user", Payload: map[string]any{"text": "turn-2 input"}},
			},
		},
		msgFound: true,
	}
	host := newRetryTestHost(store)
	_, err := host.findTurnUserMessageContent(context.Background(), SessionRef{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
	}, "turn-2")
	if err != nil {
		t.Fatalf("findTurnUserMessageContent error = %v", err)
	}
	if store.capturedTurnID != "turn-2" {
		t.Fatalf("ListSessionMessages called with TurnID=%q, want %q", store.capturedTurnID, "turn-2")
	}
}
