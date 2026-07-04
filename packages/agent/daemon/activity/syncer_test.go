package agentsessionstore

import (
	"context"
	"reflect"
	"sort"
	"sync"
	"testing"
	"time"
)

func TestAgentActivitySyncerSyncsSessionMessages(t *testing.T) {
	client := newFakeSyncerRepository()
	client.snapshots["room-1"] = &WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:  "agent-session-1",
			SessionOrigin:   WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus: "active",
			EffectiveStatus: "working",
		}},
	}
	client.messages["room-1/agent-session-1"] = []ListSessionMessagesReply{
		{
			Messages: []WorkspaceAgentSessionMessage{{
				ID:             10,
				AgentSessionID: "agent-session-1",
				MessageID:      "message-1",
				Role:           "user",
				Kind:           "message",
				Payload:        map[string]any{"content": "hello"},
				Version:        1,
			}},
			LatestVersion: 1,
			HasMore:       true,
		},
		{
			Messages: []WorkspaceAgentSessionMessage{{
				ID:             11,
				AgentSessionID: "agent-session-1",
				MessageID:      "message-2",
				Role:           "assistant",
				Kind:           "message",
				Payload:        map[string]any{"content": "world"},
				Version:        2,
			}},
			LatestVersion: 2,
		},
	}

	svc := New(client)
	svc.TrackRoom("room-1")
	syncer := newSessionSyncer(svc, client)

	syncer.syncAllRooms(context.Background())

	snapshot, ok := svc.GetAgentSnapshot("room-1")
	if !ok {
		t.Fatal("missing room snapshot")
	}
	messages := snapshot.SessionMessagesByID["agent-session-1"]
	if len(messages) != 2 {
		t.Fatalf("messages = %#v, want 2", messages)
	}
	if messages[0].MessageID != "message-1" || messages[1].MessageID != "message-2" {
		t.Fatalf("message order = %#v, want message-1,message-2", messages)
	}
	if got := client.afterVersionsFor("agent-session-1"); !reflect.DeepEqual(got, []uint64{0, 1}) {
		t.Fatalf("AfterVersions = %#v, want [0 1]", got)
	}
	if got := client.messageOriginsFor("agent-session-1"); !reflect.DeepEqual(got, []string{WorkspaceAgentSessionOriginRuntime, WorkspaceAgentSessionOriginRuntime}) {
		t.Fatalf("SessionOrigins = %#v, want runtime paging", got)
	}
}

func TestAgentActivitySyncerRemoteMessageEchoOnlyAdvancesCursor(t *testing.T) {
	client := newFakeSyncerRepository()
	client.snapshots["room-1"] = &WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:  "agent-session-1",
			SessionOrigin:   WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus: "active",
			EffectiveStatus: "working",
		}},
	}
	client.messages["room-1/agent-session-1"] = []ListSessionMessagesReply{{
		Messages: []WorkspaceAgentSessionMessage{{
			ID:               10,
			AgentSessionID:   "agent-session-1",
			MessageID:        "message-1",
			Role:             "assistant",
			Kind:             "text",
			Status:           "completed",
			Payload:          map[string]any{"text": "hello"},
			OccurredAtUnixMS: 1000,
			Version:          7,
		}},
		LatestVersion: 7,
	}}

	svc := New(client)
	svc.TrackRoom("room-1")
	svc.updateStateForOrigin("room-1", *client.snapshots["room-1"], WorkspaceAgentSessionOriginRuntime)
	var notifyCount int
	svc.SetUpdateListener(func(string, WorkspaceAgentSnapshot) {
		notifyCount++
	})
	svc.ApplySessionMessages("room-1", EventSource{AgentID: "agent-session-1"}, "agent-session-1", []WorkspaceAgentSessionMessageUpdate{{
		MessageID:        "message-1",
		Role:             "assistant",
		Kind:             "text",
		Status:           "completed",
		Payload:          map[string]any{"text": "hello"},
		OccurredAtUnixMS: 1000,
	}})
	if notifyCount != 1 {
		t.Fatalf("notify count after local message = %d, want 1", notifyCount)
	}

	syncer := newSessionSyncer(svc, client)
	syncer.syncRoom(context.Background(), "room-1")

	if notifyCount != 1 {
		t.Fatalf("notify count after remote echo sync = %d, want unchanged", notifyCount)
	}
	reply, ok := svc.ListSessionMessages("room-1", "agent-session-1", 0, 10)
	if !ok || reply.LatestVersion != 1 || len(reply.Messages) != 1 || reply.Messages[0].Version != 1 {
		t.Fatalf("messages reply = %#v, ok=%v, want local cursor metadata preserved", reply, ok)
	}
}

func TestAgentActivitySyncerUsesRuntimeSessionOriginForMessageSync(t *testing.T) {
	client := newFakeSyncerRepository()
	client.snapshots["room-1"] = &WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{
			{
				AgentSessionID:  "runtime-1",
				SessionOrigin:   WorkspaceAgentSessionOriginRuntime,
				LifecycleStatus: "active",
				EffectiveStatus: "working",
			},
			{
				AgentSessionID:  "runtime-2",
				SessionOrigin:   WorkspaceAgentSessionOriginRuntime,
				LifecycleStatus: "active",
				EffectiveStatus: "working",
			},
		},
	}
	client.messages["room-1/runtime-1"] = []ListSessionMessagesReply{{}}
	client.messages["room-1/runtime-2"] = []ListSessionMessagesReply{{}}

	svc := New(client)
	svc.TrackRoom("room-1")
	syncer := newSessionSyncer(svc, client)

	syncer.syncAllRooms(context.Background())

	if got := client.messageOriginsFor("runtime-1"); !reflect.DeepEqual(got, []string{WorkspaceAgentSessionOriginRuntime}) {
		t.Fatalf("runtime origins = %#v, want runtime", got)
	}
	if got := client.messageOriginsFor("runtime-2"); !reflect.DeepEqual(got, []string{WorkspaceAgentSessionOriginRuntime}) {
		t.Fatalf("runtime origins = %#v, want runtime", got)
	}
}

func TestAgentActivitySyncerReplacesRuntimeSessionsWhenSyncingDefaultSnapshot(t *testing.T) {
	client := newFakeSyncerRepository()
	client.snapshots["room-1"] = &WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:  "remote-runtime-1",
			SessionOrigin:   WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus: "active",
			EffectiveStatus: "working",
		}},
	}

	svc := New(client)
	svc.TrackRoom("room-1")
	svc.updateState("room-1", WorkspaceAgentSnapshot{
		Sessions: []WorkspaceAgentSession{{
			AgentSessionID:  "runtime-1",
			SessionOrigin:   WorkspaceAgentSessionOriginRuntime,
			UserID:          "user-1",
			LifecycleStatus: "active",
			EffectiveStatus: "working",
			UpdatedAtUnixMS: 100,
		}},
	})
	syncer := newSessionSyncer(svc, client)

	syncer.syncRoom(context.Background(), "room-1")

	state, ok := svc.GetAgentState("room-1")
	if !ok {
		t.Fatal("missing room state")
	}
	got := sessionIDs(state.Sessions)
	want := []string{"remote-runtime-1"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sessions = %#v, want %#v", got, want)
	}
}

func TestStoreStartIsIdempotent(t *testing.T) {
	client := newFakeSyncerRepository()
	client.snapshots["room-1"] = &WorkspaceAgentSnapshot{}
	svc := New(client)
	svc.TrackRoom("room-1")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	svc.Start(ctx)
	svc.Start(ctx)

	if !client.waitForListCalls("room-1", 1, time.Second) {
		t.Fatal("timed out waiting for initial sync")
	}
	select {
	case <-client.listCallSeen("room-1"):
		t.Fatal("second Start launched a duplicate immediate sync")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestAgentActivitySyncerTriggeredRoomsReturnWhenContextCanceled(t *testing.T) {
	client := newFakeSyncerRepository()
	client.snapshots["room-1"] = &WorkspaceAgentSnapshot{}
	svc := New(client)
	svc.TrackRoom("room-1")
	syncer := newSessionSyncer(svc, client)
	for i := 0; i < cap(syncer.triggers); i++ {
		syncer.triggerRoom("room-1")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		syncer.syncTriggeredRooms(ctx, "room-1")
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("syncTriggeredRooms did not return after cancellation")
	}
	if got := client.listCallCount("room-1"); got != 0 {
		t.Fatalf("list calls after canceled trigger drain = %d, want 0", got)
	}
}

func TestAgentActivitySyncerTriggerRoomDoesNotBlockWhenFull(t *testing.T) {
	syncer := newSessionSyncer(New(nil), nil)

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 128; i++ {
			syncer.triggerRoom("room-1")
		}
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("triggerRoom blocked with a full trigger buffer")
	}
}

type fakeSyncerRepository struct {
	mu                sync.Mutex
	snapshots         map[string]*WorkspaceAgentSnapshot
	snapshotSequences map[string][]*WorkspaceAgentSnapshot
	messages          map[string][]ListSessionMessagesReply
	messageInputs     []ListSessionMessagesInput
	listCalls         map[string]int
	listWaiters       map[string][]chan struct{}
}

func newFakeSyncerRepository() *fakeSyncerRepository {
	return &fakeSyncerRepository{
		snapshots:         make(map[string]*WorkspaceAgentSnapshot),
		snapshotSequences: make(map[string][]*WorkspaceAgentSnapshot),
		messages:          make(map[string][]ListSessionMessagesReply),
		listCalls:         make(map[string]int),
		listWaiters:       make(map[string][]chan struct{}),
	}
}

func (f *fakeSyncerRepository) ListAgents(_ context.Context, roomID string) (*WorkspaceAgentSnapshot, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.listCalls[roomID]++
	for _, waiter := range f.listWaiters[roomID] {
		close(waiter)
	}
	delete(f.listWaiters, roomID)

	if snapshots := f.snapshotSequences[roomID]; len(snapshots) > 0 {
		snapshot := snapshots[0]
		if len(snapshots) == 1 {
			f.snapshots[roomID] = snapshot
		}
		f.snapshotSequences[roomID] = snapshots[1:]
		return snapshot, nil
	}
	return f.snapshots[roomID], nil
}

func (f *fakeSyncerRepository) ListSessionMessages(_ context.Context, input ListSessionMessagesInput) (*ListSessionMessagesReply, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.messageInputs = append(f.messageInputs, input)
	key := input.WorkspaceID + "/" + input.AgentSessionID
	pages := f.messages[key]
	if len(pages) == 0 {
		return &ListSessionMessagesReply{}, nil
	}
	page := pages[0]
	f.messages[key] = pages[1:]
	return &page, nil
}

func (f *fakeSyncerRepository) afterVersionsFor(agentSessionID string) []uint64 {
	f.mu.Lock()
	defer f.mu.Unlock()

	afterVersions := make([]uint64, 0, len(f.messageInputs))
	for _, input := range f.messageInputs {
		if input.AgentSessionID == agentSessionID {
			afterVersions = append(afterVersions, input.AfterVersion)
		}
	}
	sort.Slice(afterVersions, func(i, j int) bool { return afterVersions[i] < afterVersions[j] })
	return afterVersions
}

func (f *fakeSyncerRepository) messageOriginsFor(agentSessionID string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()

	origins := make([]string, 0, len(f.messageInputs))
	for _, input := range f.messageInputs {
		if input.AgentSessionID == agentSessionID {
			origins = append(origins, input.SessionOrigin)
		}
	}
	return origins
}

func (f *fakeSyncerRepository) listCallCount(roomID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.listCalls[roomID]
}

func (f *fakeSyncerRepository) listCallSeen(roomID string) <-chan struct{} {
	f.mu.Lock()
	defer f.mu.Unlock()

	ch := make(chan struct{})
	f.listWaiters[roomID] = append(f.listWaiters[roomID], ch)
	return ch
}

func (f *fakeSyncerRepository) waitForListCalls(roomID string, count int, timeout time.Duration) bool {
	deadline := time.After(timeout)
	for {
		if f.listCallCount(roomID) >= count {
			return true
		}
		select {
		case <-f.listCallSeen(roomID):
		case <-deadline:
			return f.listCallCount(roomID) >= count
		}
	}
}

func sessionIDs(sessions []WorkspaceAgentSession) []string {
	ids := make([]string, 0, len(sessions))
	for _, session := range sessions {
		if id := session.AgentSessionID; id != "" {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}
