package agent

import (
	"context"
	"errors"
	"testing"
)

func TestServiceDoesNotRestoreTombstonedRuntimeSession(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:deleted-session"] = ProviderRuntimeSession{
		ID:          "deleted-session",
		WorkspaceID: "ws-1",
		Provider:    "codex",
		Visible:     true,
	}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		tombstoned: map[string]bool{"ws-1:deleted-session": true},
	}

	sessions, err := service.List(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	if len(sessions) != 0 {
		t.Fatalf("List returned tombstoned runtime session: %#v", sessions)
	}
	if _, err := service.Get(context.Background(), "ws-1", "deleted-session"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("Get error = %v, want ErrSessionNotFound", err)
	}
	if _, err := service.ListMessages(context.Background(), "ws-1", "deleted-session", ListMessagesInput{}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("ListMessages error = %v, want ErrSessionNotFound", err)
	}
}
