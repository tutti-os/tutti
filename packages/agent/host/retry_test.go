package agenthost

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	_ "modernc.org/sqlite"
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

type retryDurableRuntime struct {
	RuntimeController
	store           *storesqlite.Store
	session         ProviderRuntimeSession
	execCalls       []RuntimeExecInput
	provenanceCalls []RuntimeSubmitProvenanceInput
}

func (r *retryDurableRuntime) Session(_, _ string) (ProviderRuntimeSession, bool) {
	return r.session, true
}

func (*retryDurableRuntime) ValidatePromptContent(_ context.Context, _ RuntimeExecInput) error {
	return nil
}

func (r *retryDurableRuntime) Exec(ctx context.Context, input RuntimeExecInput) (RuntimeExecResult, error) {
	r.execCalls = append(r.execCalls, input)
	if _, accepted, err := r.store.RecordTurnTransition(ctx, storesqlite.TurnTransition{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, TurnID: input.TurnID,
		Phase: storesqlite.TurnPhaseSubmitted, ParentTurnID: input.TurnLineage.ParentTurnID,
		Relation: storesqlite.TurnRelation(input.TurnLineage.Relation), OccurredAtUnixMS: 10,
	}); err != nil || !accepted {
		return RuntimeExecResult{}, err
	}
	return RuntimeExecResult{AgentSessionID: input.AgentSessionID, TurnID: input.TurnID, Accepted: true, TurnLifecycle: TurnLifecycle{Phase: "submitted"}}, nil
}

func (r *retryDurableRuntime) DurablyReportSubmitProvenance(ctx context.Context, input RuntimeSubmitProvenanceInput) error {
	r.provenanceCalls = append(r.provenanceCalls, input)
	_, err := r.store.ReportSessionMessages(ctx, storesqlite.SessionMessageReport{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Origin: "runtime", Provider: "codex",
		Messages: []storesqlite.MessageUpdate{{
			MessageID: "client-submit:user:" + input.ClientSubmitID, TurnID: input.TurnID, Role: "user", Kind: "text", Status: "completed",
			Payload: map[string]any{"clientSubmitId": input.ClientSubmitID}, OccurredAtUnixMS: 11,
		}},
	})
	return err
}

func (s *retryMockStore) GetTurn(_ context.Context, _, _, _ string) (storesqlite.Turn, bool, error) {
	return s.turn, s.turnFound, s.turnErr
}

func (s *retryMockStore) ListSessionMessages(_ context.Context, input storesqlite.ListSessionMessagesInput) (storesqlite.MessagePage, bool, error) {
	s.capturedTurnID = input.TurnID
	return s.messages, s.msgFound, s.msgErr
}

// Stubs for the rest of CanonicalStore — not called in validation paths.
func (retryMockStore) GetSession(context.Context, string, string) (storesqlite.Session, bool, error) {
	return storesqlite.Session{}, false, nil
}
func (retryMockStore) SessionDeleted(context.Context, string, string) (bool, error) {
	return false, nil
}
func (retryMockStore) RollbackRuntimeSessionInitialization(context.Context, string, string) (bool, error) {
	return false, nil
}
func (retryMockStore) InitializeRuntimeSession(context.Context, ProviderRuntimeSession) (storesqlite.Session, error) {
	return storesqlite.Session{}, nil
}
func (retryMockStore) UpdateSessionTitle(context.Context, string, string, string) (storesqlite.Session, bool, error) {
	return storesqlite.Session{}, false, nil
}
func (retryMockStore) ListChildSessions(context.Context, string, string) ([]storesqlite.Session, error) {
	return nil, nil
}
func (retryMockStore) FindTurnByClientSubmitID(context.Context, string, string, string) (string, bool, error) {
	return "", false, nil
}
func (retryMockStore) ListLatestTurnInteractions(context.Context, string, []string) (map[string][]storesqlite.Interaction, error) {
	return nil, nil
}
func (retryMockStore) ListSessionInteractions(context.Context, storesqlite.ListSessionInteractionsInput) ([]storesqlite.Interaction, error) {
	return nil, nil
}
func (retryMockStore) PrepareSubmitClaim(context.Context, storesqlite.SubmitClaimPrepare) (storesqlite.SubmitClaim, bool, error) {
	return storesqlite.SubmitClaim{}, false, nil
}
func (retryMockStore) AcceptSubmitClaim(context.Context, string, string, string, string, int64) (storesqlite.SubmitClaim, bool, error) {
	return storesqlite.SubmitClaim{}, false, nil
}
func (retryMockStore) DeleteSubmitClaim(context.Context, string, string, string) (bool, error) {
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

func TestRetryTurnRestoresStructuredPromptContent(t *testing.T) {
	host := newRetryTestHost(&retryMockStore{messages: storesqlite.MessagePage{Messages: []storesqlite.Message{{
		Role: "user",
		Payload: map[string]any{
			"text": "display text must not replace the provider prompt",
			"content": []any{
				map[string]any{"type": "text", "text": "first"},
				map[string]any{"type": "image", "mimeType": "image/png", "data": "aW1hZ2U=", "attachmentId": "attachment-1", "name": "screen.png", "path": "/safe/screen.png"},
				map[string]any{"type": "text", "text": "last"},
			},
		},
	}}}})

	content, err := host.findTurnUserMessageContent(t.Context(), SessionRef{WorkspaceID: "ws-1", AgentSessionID: "session-1"}, "turn-1")
	if err != nil {
		t.Fatal(err)
	}
	want := []PromptContentBlock{
		{Type: "text", Text: "first"},
		{Type: "image", MimeType: "image/png", Data: "aW1hZ2U=", AttachmentID: "attachment-1", Name: "screen.png", Path: "/safe/screen.png"},
		{Type: "text", Text: "last"},
	}
	if !reflect.DeepEqual(content, want) {
		t.Fatalf("structured content = %#v, want %#v", content, want)
	}
}

func TestRetryTurnRestoresImageOnlyAndURLPromptContent(t *testing.T) {
	for _, test := range []struct {
		name  string
		block map[string]any
		want  PromptContentBlock
	}{
		{
			name: "attachment", block: map[string]any{"type": "image", "mimeType": "image/png", "attachmentId": "attachment-1", "name": "screen.png"},
			want: PromptContentBlock{Type: "image", MimeType: "image/png", AttachmentID: "attachment-1", Name: "screen.png"},
		},
		{
			name: "url", block: map[string]any{"type": "image", "mimeType": "image/jpeg", "url": "https://example.com/image.jpg", "attachmentId": "attachment-2", "name": "image.jpg"},
			want: PromptContentBlock{Type: "image", MimeType: "image/jpeg", URL: "https://example.com/image.jpg", AttachmentID: "attachment-2", Name: "image.jpg"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			host := newRetryTestHost(&retryMockStore{messages: storesqlite.MessagePage{Messages: []storesqlite.Message{{
				Role: "user", Payload: map[string]any{"content": []any{test.block}},
			}}}})
			content, err := host.findTurnUserMessageContent(t.Context(), SessionRef{WorkspaceID: "ws-1", AgentSessionID: "session-1"}, "turn-1")
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(content, []PromptContentBlock{test.want}) {
				t.Fatalf("image content = %#v, want %#v", content, []PromptContentBlock{test.want})
			}
		})
	}
}

func TestRetryTurnRejectsMalformedStructuredPromptContent(t *testing.T) {
	host := newRetryTestHost(&retryMockStore{messages: storesqlite.MessagePage{Messages: []storesqlite.Message{{
		Role: "user", Payload: map[string]any{"content": map[string]any{"type": "text", "text": "not an array"}, "text": "do not fall back"},
	}}}})
	_, err := host.findTurnUserMessageContent(t.Context(), SessionRef{WorkspaceID: "ws-1", AgentSessionID: "session-1"}, "turn-1")
	if !errors.Is(err, ErrTurnPromptUnrecoverable) {
		t.Fatalf("findTurnUserMessageContent() error = %v, want ErrTurnPromptUnrecoverable", err)
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

func TestValidateTurnLineageRejectsInvalidOrUnsettledParent(t *testing.T) {
	ref := SessionRef{WorkspaceID: "ws-1", AgentSessionID: "session-1"}
	for _, test := range []struct {
		name    string
		turnID  string
		lineage *TurnLineage
		turn    storesqlite.Turn
		found   bool
		want    error
	}{
		{name: "relation without parent", turnID: "child", lineage: &TurnLineage{Relation: TurnRelationRetry}, want: ErrInvalidTurnLineage},
		{name: "self parent", turnID: "child", lineage: &TurnLineage{ParentTurnID: "child", Relation: TurnRelationRetry}, want: ErrInvalidTurnLineage},
		{name: "unknown parent", turnID: "child", lineage: &TurnLineage{ParentTurnID: "parent", Relation: TurnRelationRetry}, want: ErrTurnNotFound},
		{name: "unsettled parent", turnID: "child", lineage: &TurnLineage{ParentTurnID: "parent", Relation: TurnRelationRetry}, turn: storesqlite.Turn{Phase: storesqlite.TurnPhaseRunning}, found: true, want: ErrTurnNotSettled},
	} {
		t.Run(test.name, func(t *testing.T) {
			host := newRetryTestHost(&retryMockStore{turn: test.turn, turnFound: test.found})
			_, err := host.validateTurnLineage(t.Context(), ref, test.turnID, test.lineage)
			if !errors.Is(err, test.want) {
				t.Fatalf("validateTurnLineage() error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestRetryTurnUsesStableSubmitClaimAndDurableProvenance(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "retry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	canonical := storesqlite.New(db, storesqlite.Options{})
	if err := canonical.Migrate(t.Context()); err != nil {
		t.Fatal(err)
	}
	workspaceStore := &SQLiteWorkspaceStore{StoreForWorkspace: func(string) *storesqlite.Store { return canonical }}
	if _, err := workspaceStore.InitializeRuntimeSession(t.Context(), ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", AgentTargetID: "target-1", Provider: "codex", Status: "ready", CreatedAtUnixMS: 1, UpdatedAtUnixMS: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := canonical.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "parent-turn", Phase: storesqlite.TurnPhaseSettled,
		Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("seed parent turn accepted=%v err=%v", accepted, err)
	}
	if _, err := canonical.ReportSessionMessages(t.Context(), storesqlite.SessionMessageReport{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Origin: "runtime", Provider: "codex",
		Messages: []storesqlite.MessageUpdate{{
			MessageID: "parent-message", TurnID: "parent-turn", Role: "user", Kind: "text", Status: "completed",
			Payload: map[string]any{"content": []any{map[string]any{"type": "text", "text": "retry me"}}}, OccurredAtUnixMS: 3,
		}},
	}); err != nil {
		t.Fatal(err)
	}
	runtime := &retryDurableRuntime{store: canonical, session: ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "workspace-1", Provider: "codex", Status: "ready",
	}}
	host := New(Config{CanonicalStore: workspaceStore, Runtime: runtime})
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}

	first, err := host.RetryTurn(t.Context(), ref, "parent-turn")
	if err != nil {
		t.Fatal(err)
	}
	second, err := host.RetryTurn(t.Context(), ref, "parent-turn")
	if err != nil {
		t.Fatal(err)
	}
	if first.TurnID == "" || second.TurnID != first.TurnID || len(runtime.execCalls) != 1 || len(runtime.provenanceCalls) != 1 {
		t.Fatalf("retry results=%#v/%#v exec=%#v provenance=%#v", first, second, runtime.execCalls, runtime.provenanceCalls)
	}
	if runtime.execCalls[0].ClientSubmitID == "" || runtime.provenanceCalls[0].ClientSubmitID != runtime.execCalls[0].ClientSubmitID {
		t.Fatalf("retry client submit IDs exec=%q provenance=%q", runtime.execCalls[0].ClientSubmitID, runtime.provenanceCalls[0].ClientSubmitID)
	}
	claim, found, err := canonical.GetSubmitClaim(t.Context(), ref.WorkspaceID, ref.AgentSessionID, runtime.execCalls[0].ClientSubmitID)
	if err != nil || !found || claim.Status != "accepted" || claim.TurnID != first.TurnID {
		t.Fatalf("retry submit claim=%#v found=%v err=%v", claim, found, err)
	}
}
