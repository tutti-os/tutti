package agenthost

import (
	"context"
	"errors"
	"reflect"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type canonicalQueryStore struct {
	CanonicalStore
	wantWorkspaceID  string
	wantSessionID    string
	wantTurnID       string
	wantMessageQuery storesqlite.ListSessionMessagesInput
	turn             storesqlite.Turn
	messagePage      storesqlite.MessagePage
	messageFound     bool
	err              error
	interactions     map[string][]storesqlite.Interaction
}

func (s canonicalQueryStore) GetTurn(_ context.Context, workspaceID, sessionID, turnID string) (storesqlite.Turn, bool, error) {
	if workspaceID != s.wantWorkspaceID || sessionID != s.wantSessionID || turnID != s.wantTurnID {
		return storesqlite.Turn{}, false, errors.New("unexpected canonical turn key")
	}
	return s.turn, true, s.err
}

func (s canonicalQueryStore) GetSession(_ context.Context, workspaceID, sessionID string) (storesqlite.Session, bool, error) {
	if workspaceID != s.wantWorkspaceID || sessionID != s.wantSessionID {
		return storesqlite.Session{}, false, errors.New("unexpected canonical session key")
	}
	return storesqlite.Session{WorkspaceID: workspaceID, ID: sessionID}, true, s.err
}

func (s canonicalQueryStore) SessionDeleted(_ context.Context, workspaceID, sessionID string) (bool, error) {
	if workspaceID != s.wantWorkspaceID || sessionID != s.wantSessionID {
		return false, errors.New("unexpected canonical session key")
	}
	return false, s.err
}

func (s canonicalQueryStore) ListLatestTurnInteractions(_ context.Context, workspaceID string, sessionIDs []string) (map[string][]storesqlite.Interaction, error) {
	if workspaceID != s.wantWorkspaceID || len(sessionIDs) != 1 || sessionIDs[0] != s.wantSessionID {
		return nil, errors.New("unexpected latest-turn interaction key")
	}
	return s.interactions, s.err
}

func (s canonicalQueryStore) ListSessionMessages(_ context.Context, input storesqlite.ListSessionMessagesInput) (storesqlite.MessagePage, bool, error) {
	if !reflect.DeepEqual(input, s.wantMessageQuery) {
		return storesqlite.MessagePage{}, false, errors.New("unexpected canonical message query")
	}
	return s.messagePage, s.messageFound, s.err
}

func TestGetTurnDelegatesCanonicalQueryWithNormalizedIdentity(t *testing.T) {
	want := storesqlite.Turn{WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1"}
	host := New(Config{CanonicalStore: canonicalQueryStore{
		wantWorkspaceID: want.WorkspaceID,
		wantSessionID:   want.AgentSessionID,
		wantTurnID:      want.TurnID,
		turn:            want,
	}})

	got, found, err := host.GetTurn(t.Context(), SessionRef{
		WorkspaceID: " workspace-1 ", AgentSessionID: " session-1 ",
	}, " turn-1 ")
	if err != nil || !found || !reflect.DeepEqual(got, want) {
		t.Fatalf("GetTurn() = (%#v, %v, %v), want (%#v, true, nil)", got, found, err, want)
	}
}

func TestGetTurnRejectsIncompleteIdentity(t *testing.T) {
	host := New(Config{CanonicalStore: canonicalQueryStore{}})
	for _, test := range []struct {
		name   string
		ref    SessionRef
		turnID string
	}{
		{name: "workspace", ref: SessionRef{AgentSessionID: "session-1"}, turnID: "turn-1"},
		{name: "session", ref: SessionRef{WorkspaceID: "workspace-1"}, turnID: "turn-1"},
		{name: "turn", ref: SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := host.GetTurn(t.Context(), test.ref, test.turnID); !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("GetTurn() error = %v, want %v", err, ErrInvalidArgument)
			}
		})
	}
}

func TestListSessionMessagesDelegatesCanonicalQueryWithNormalizedIdentity(t *testing.T) {
	wantQuery := storesqlite.ListSessionMessagesInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", MessageID: "message-1", TurnID: "turn-1",
		AfterVersion: 7, BeforeVersion: 20, Limit: 25, Order: storesqlite.MessageOrderAsc,
	}
	wantPage := storesqlite.MessagePage{
		AgentSessionID: "session-1", LatestVersion: 9,
		Messages: []storesqlite.Message{{AgentSessionID: "session-1", MessageID: "message-1", TurnID: "turn-1", Version: 9}},
	}
	host := New(Config{CanonicalStore: canonicalQueryStore{
		wantMessageQuery: wantQuery,
		messagePage:      wantPage,
		messageFound:     true,
	}})

	got, found, err := host.ListSessionMessages(t.Context(), SessionRef{
		WorkspaceID: " workspace-1 ", AgentSessionID: " session-1 ",
	}, SessionMessageQuery{
		MessageID: " message-1 ", TurnID: " turn-1 ", AfterVersion: 7, BeforeVersion: 20,
		Limit: 25, Order: storesqlite.MessageOrderAsc,
	})
	if err != nil || !found || !reflect.DeepEqual(got, wantPage) {
		t.Fatalf("ListSessionMessages() = (%#v, %v, %v), want (%#v, true, nil)", got, found, err, wantPage)
	}
}

func TestListSessionMessagesRejectsIncompleteIdentity(t *testing.T) {
	host := New(Config{CanonicalStore: canonicalQueryStore{}})
	for _, ref := range []SessionRef{{WorkspaceID: "workspace-1"}, {AgentSessionID: "session-1"}, {}} {
		if _, _, err := host.ListSessionMessages(t.Context(), ref, SessionMessageQuery{}); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("ListSessionMessages(%#v) error = %v, want %v", ref, err, ErrInvalidArgument)
		}
	}
}

func TestGetSessionInteractionSnapshotDerivesPendingFromLatestTurnRead(t *testing.T) {
	interactions := []storesqlite.Interaction{
		{WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-2", RequestID: "pending", Status: storesqlite.InteractionStatusPending},
		{WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-2", RequestID: "answered", Status: storesqlite.InteractionStatusAnswered},
		{WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-2", RequestID: "superseded", Status: storesqlite.InteractionStatusSuperseded},
	}
	host := New(Config{CanonicalStore: canonicalQueryStore{
		wantWorkspaceID: "workspace-1", wantSessionID: "session-1",
		interactions: map[string][]storesqlite.Interaction{"session-1": interactions},
	}})

	snapshot, err := host.GetSessionInteractionSnapshot(t.Context(), SessionRef{
		WorkspaceID: " workspace-1 ", AgentSessionID: " session-1 ",
	})
	if err != nil {
		t.Fatalf("GetSessionInteractionSnapshot() error = %v", err)
	}
	if !reflect.DeepEqual(snapshot.Interactions, interactions) {
		t.Fatalf("Interactions = %#v, want %#v", snapshot.Interactions, interactions)
	}
	if len(snapshot.PendingInteractions) != 1 || snapshot.PendingInteractions[0].RequestID != "pending" {
		t.Fatalf("PendingInteractions = %#v, want only pending", snapshot.PendingInteractions)
	}
}

func TestGetSessionInteractionSnapshotRejectsIncompleteIdentity(t *testing.T) {
	host := New(Config{CanonicalStore: canonicalQueryStore{}})
	for _, ref := range []SessionRef{{WorkspaceID: "workspace-1"}, {AgentSessionID: "session-1"}, {}} {
		if _, err := host.GetSessionInteractionSnapshot(t.Context(), ref); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("GetSessionInteractionSnapshot(%#v) error = %v, want %v", ref, err, ErrInvalidArgument)
		}
	}
}
