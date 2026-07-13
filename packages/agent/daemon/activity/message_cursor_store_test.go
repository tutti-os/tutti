package agentsessionstore

import (
	"context"
	"reflect"
	"testing"
)

func TestFileAgentSyncStateStoreMessageCursorRoundtrip(t *testing.T) {
	store := NewFileAgentSyncStateStore(t.TempDir())
	ctx := context.Background()

	if err := store.SaveMessageCursor(ctx, "room-1", "session-1", 7); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveMessageCursor(ctx, "room-1", "session-2", 3); err != nil {
		t.Fatal(err)
	}
	// Cursors and sync states share the room document without clobbering
	// each other.
	if err := store.SaveAgentSyncState(ctx, "room-1", WorkspaceAgentSyncState{
		AgentSessionID: "session-1",
		Status:         WorkspaceAgentSyncStatusSynced,
	}); err != nil {
		t.Fatal(err)
	}

	cursors, err := store.LoadRoomMessageCursors(ctx, "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]uint64{"session-1": 7, "session-2": 3}; !reflect.DeepEqual(cursors, want) {
		t.Fatalf("cursors = %#v, want %#v", cursors, want)
	}
	syncStates, err := store.LoadRoomSyncStates(ctx, "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if syncStates["session-1"].Status != WorkspaceAgentSyncStatusSynced {
		t.Fatalf("sync states = %#v, want session-1 synced", syncStates)
	}

	if err := store.DeleteMessageCursor(ctx, "room-1", "session-1"); err != nil {
		t.Fatal(err)
	}
	cursors, err = store.LoadRoomMessageCursors(ctx, "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]uint64{"session-2": 3}; !reflect.DeepEqual(cursors, want) {
		t.Fatalf("cursors after delete = %#v, want %#v", cursors, want)
	}
}

func TestFileAgentSyncStateStoreLoadMessageCursorsMissingRoom(t *testing.T) {
	store := NewFileAgentSyncStateStore(t.TempDir())
	cursors, err := store.LoadRoomMessageCursors(context.Background(), "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(cursors) != 0 {
		t.Fatalf("cursors = %#v, want empty", cursors)
	}
}

func TestStoreResumesMessageSyncFromPersistedCursor(t *testing.T) {
	dir := t.TempDir()
	cursorStore := NewFileAgentSyncStateStore(dir)
	snapshot := &WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			AgentSessionID:  "session-1",
			SessionOrigin:   WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus: "active",
			EffectiveStatus: "working",
		}},
	}

	client := newFakeSyncerRepository()
	client.snapshots["room-1"] = snapshot
	client.messages["room-1/session-1"] = []ListSessionMessagesReply{{
		Messages: []WorkspaceAgentSessionMessage{{
			AgentSessionID: "session-1",
			MessageID:      "message-1",
			Role:           "assistant",
			Kind:           "text",
			Version:        2,
		}},
		LatestVersion: 2,
	}}

	svc := New(client, WithMessageCursorStore(cursorStore))
	svc.TrackRoom("room-1")
	syncer := newSessionSyncer(svc, client)
	syncer.syncAllRooms(context.Background())

	cursors, err := cursorStore.LoadRoomMessageCursors(context.Background(), "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if cursors["session-1"] != 2 {
		t.Fatalf("persisted cursor = %#v, want session-1 => 2", cursors)
	}

	// A fresh Store (simulated restart) seeds the cursor from the store and
	// resumes paging after the persisted version.
	restartClient := newFakeSyncerRepository()
	restartClient.snapshots["room-1"] = snapshot
	restarted := New(restartClient, WithMessageCursorStore(cursorStore))
	restarted.TrackRoom("room-1")
	restartSyncer := newSessionSyncer(restarted, restartClient)
	restartSyncer.syncAllRooms(context.Background())

	if got := restartClient.afterVersionsFor("session-1"); !reflect.DeepEqual(got, []uint64{2}) {
		t.Fatalf("after versions on restart = %#v, want [2]", got)
	}
}

func TestStoreWithoutCursorStoreStartsFromZeroAfterRestart(t *testing.T) {
	snapshot := &WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			AgentSessionID:  "session-1",
			SessionOrigin:   WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus: "active",
			EffectiveStatus: "working",
		}},
	}
	client := newFakeSyncerRepository()
	client.snapshots["room-1"] = snapshot

	svc := New(client)
	svc.TrackRoom("room-1")
	syncer := newSessionSyncer(svc, client)
	syncer.syncAllRooms(context.Background())

	if got := client.afterVersionsFor("session-1"); !reflect.DeepEqual(got, []uint64{0}) {
		t.Fatalf("after versions without cursor store = %#v, want [0]", got)
	}
}

func TestAppendSessionMessagesDoesNotPersistCursorForHiddenSession(t *testing.T) {
	cursorStore := NewFileAgentSyncStateStore(t.TempDir())
	client := newFakeSyncerRepository()
	client.snapshots["room-1"] = &WorkspaceAgentSnapshot{}

	svc := New(client, WithMessageCursorStore(cursorStore))
	svc.TrackRoom("room-1")
	svc.HideAgentSession("room-1", "session-1")

	// A late-arriving sync result for a hidden session must not resurrect
	// its persisted cursor.
	svc.appendSessionMessages("room-1", "session-1", []WorkspaceAgentSessionMessage{{
		AgentSessionID: "session-1",
		MessageID:      "message-1",
		Role:           "assistant",
		Kind:           "text",
		Version:        4,
	}}, 4)

	cursors, err := cursorStore.LoadRoomMessageCursors(context.Background(), "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(cursors) != 0 {
		t.Fatalf("cursors after hidden-session append = %#v, want empty", cursors)
	}
}

func TestHideAgentSessionDeletesPersistedCursor(t *testing.T) {
	cursorStore := NewFileAgentSyncStateStore(t.TempDir())
	client := newFakeSyncerRepository()
	client.snapshots["room-1"] = &WorkspaceAgentSnapshot{}

	svc := New(client, WithMessageCursorStore(cursorStore))
	svc.TrackRoom("room-1")
	svc.appendSessionMessages("room-1", "session-1", []WorkspaceAgentSessionMessage{{
		AgentSessionID: "session-1",
		MessageID:      "message-1",
		Role:           "assistant",
		Kind:           "text",
		Version:        4,
	}}, 4)

	cursors, err := cursorStore.LoadRoomMessageCursors(context.Background(), "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if cursors["session-1"] != 4 {
		t.Fatalf("persisted cursor = %#v, want session-1 => 4", cursors)
	}

	svc.HideAgentSession("room-1", "session-1")

	cursors, err = cursorStore.LoadRoomMessageCursors(context.Background(), "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(cursors) != 0 {
		t.Fatalf("cursors after hide = %#v, want empty", cursors)
	}
}
