package agent

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestServiceUpdateSettingsPersistsHistoricalSessionWithoutRuntimeResume(t *testing.T) {
	runtime := newFakeRuntime()
	reader := &settingsUpdateSessionReader{
		fakeSessionReader: &fakeSessionReader{sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				AgentTargetID:     "local:claude-code",
				Provider:          "claude-code",
				ProviderSessionID: "provider-session-1",
				Cwd:               "/workspace",
				Settings:          ComposerSettings{Model: "default", PermissionModeID: "dontAsk"},
				CreatedAtUnixMS:   100,
				UpdatedAtUnixMS:   200,
				LastEventUnixMS:   200,
			},
		}},
		updatedAtUnixMS: 300,
	}
	service := newTestService(runtime)
	service.SessionReader = reader
	permissionModeID := "acceptEdits"

	session, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
		PermissionModeID: &permissionModeID,
	})
	if err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	if len(runtime.resumeCalls) != 0 {
		t.Fatalf("UpdateSettings runtime resume calls = %d, want 0", len(runtime.resumeCalls))
	}
	if len(runtime.updateSettingsCalls) != 0 {
		t.Fatalf("UpdateSettings live runtime calls = %d, want 0", len(runtime.updateSettingsCalls))
	}
	if reader.updateCalls != 1 {
		t.Fatalf("UpdateSessionSettings calls = %d, want 1", reader.updateCalls)
	}
	if session.Settings == nil || session.Settings.PermissionModeID != "acceptEdits" {
		t.Fatalf("UpdateSettings session settings = %#v, want acceptEdits", session.Settings)
	}
	if session.Settings.Model != "default" {
		t.Fatalf("UpdateSettings model = %q, want preserved default", session.Settings.Model)
	}
	if session.UpdatedAt == nil || session.UpdatedAt.UnixMilli() != 300 {
		t.Fatalf("UpdateSettings updatedAt = %v, want 300", session.UpdatedAt)
	}
}

func TestServiceUpdateSettingsSerializesWithHistoricalResume(t *testing.T) {
	baseRuntime := newFakeRuntime()
	runtime := &blockingResumeRuntime{
		fakeRuntime:       baseRuntime,
		resumeEntered:     make(chan RuntimeResumeInput, 1),
		resumeRelease:     make(chan struct{}),
		liveUpdateEntered: make(chan RuntimeUpdateSettingsInput, 1),
	}
	reader := &settingsUpdateSessionReader{
		fakeSessionReader: &fakeSessionReader{sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				AgentTargetID:     "local:claude-code",
				Provider:          "claude-code",
				ProviderSessionID: "provider-session-1",
				Cwd:               "/workspace",
				Settings:          ComposerSettings{PermissionModeID: "dontAsk"},
			},
		}},
		updatedAtUnixMS: 300,
	}
	service := newTestService(runtime)
	service.SessionReader = reader
	resumeDone := make(chan error, 1)
	go func() {
		_, err := service.ensureRuntimeSessionResult(context.Background(), "ws-1", "session-1")
		resumeDone <- err
	}()
	resumeInput := <-runtime.resumeEntered
	if resumeInput.Settings.PermissionModeID != "dontAsk" {
		t.Fatalf("resume permission = %q, want dontAsk", resumeInput.Settings.PermissionModeID)
	}

	permissionModeID := "acceptEdits"
	settingsStarted := make(chan struct{})
	settingsDone := make(chan error, 1)
	go func() {
		close(settingsStarted)
		_, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
			PermissionModeID: &permissionModeID,
		})
		settingsDone <- err
	}()
	<-settingsStarted
	select {
	case input := <-runtime.liveUpdateEntered:
		t.Fatalf("live settings update entered before resume completed: %#v", input)
	case <-settingsDone:
		t.Fatal("settings update completed before resume completed")
	case <-time.After(50 * time.Millisecond):
	}

	close(runtime.resumeRelease)
	if err := <-resumeDone; err != nil {
		t.Fatalf("resume returned error: %v", err)
	}
	if err := <-settingsDone; err != nil {
		t.Fatalf("UpdateSettings returned error: %v", err)
	}
	if reader.updateCalls != 0 {
		t.Fatalf("durable historical updates = %d, want 0 after runtime became live", reader.updateCalls)
	}
	if len(baseRuntime.updateSettingsCalls) != 1 {
		t.Fatalf("live runtime updates = %d, want 1", len(baseRuntime.updateSettingsCalls))
	}
	session, ok := baseRuntime.Session("ws-1", "session-1")
	if !ok || session.Settings == nil || session.Settings.PermissionModeID != "acceptEdits" {
		t.Fatalf("runtime session settings = %#v ok=%v, want acceptEdits", session.Settings, ok)
	}
}

func TestServiceUpdateSettingsStopsWaitingWhenContextIsCanceled(t *testing.T) {
	baseRuntime := newFakeRuntime()
	runtime := &blockingResumeRuntime{
		fakeRuntime:       baseRuntime,
		resumeEntered:     make(chan RuntimeResumeInput, 1),
		resumeRelease:     make(chan struct{}),
		liveUpdateEntered: make(chan RuntimeUpdateSettingsInput, 1),
	}
	reader := &settingsUpdateSessionReader{
		fakeSessionReader: &fakeSessionReader{sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				AgentTargetID:     "local:claude-code",
				Provider:          "claude-code",
				ProviderSessionID: "provider-session-1",
				Cwd:               "/workspace",
				Settings:          ComposerSettings{PermissionModeID: "dontAsk"},
			},
		}},
	}
	service := newTestService(runtime)
	service.SessionReader = reader
	resumeDone := make(chan error, 1)
	go func() {
		_, err := service.ensureRuntimeSessionResult(context.Background(), "ws-1", "session-1")
		resumeDone <- err
	}()
	select {
	case <-runtime.resumeEntered:
	case <-time.After(time.Second):
		t.Fatal("resume did not acquire the session settings lock")
	}

	ctx, cancel := context.WithCancel(context.Background())
	settingsDone := make(chan error, 1)
	permissionModeID := "acceptEdits"
	go func() {
		_, err := service.UpdateSettings(ctx, "ws-1", "session-1", ComposerSettingsPatch{
			PermissionModeID: &permissionModeID,
		})
		settingsDone <- err
	}()
	deadline := time.Now().Add(time.Second)
	for {
		service.sessionSettingsMu.Lock()
		refs := service.sessionSettingsLocks["ws-1\x00session-1"].refs
		service.sessionSettingsMu.Unlock()
		if refs == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("settings update did not begin waiting for the session settings lock")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case err := <-settingsDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("UpdateSettings error = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled settings update remained blocked on the session settings lock")
	}

	close(runtime.resumeRelease)
	if err := <-resumeDone; err != nil {
		t.Fatalf("resume returned error: %v", err)
	}
	service.sessionSettingsMu.Lock()
	remainingLocks := len(service.sessionSettingsLocks)
	service.sessionSettingsMu.Unlock()
	if remainingLocks != 0 {
		t.Fatalf("session settings locks = %d, want 0", remainingLocks)
	}
}

func TestServiceUpdateSettingsSerializesHistoricalPartialPatches(t *testing.T) {
	reader := &serializedSettingsReader{
		fakeSessionReader: &fakeSessionReader{sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "claude-code",
				Settings:    ComposerSettings{PermissionModeID: "dontAsk", PlanMode: false},
			},
		}},
		firstRead:   make(chan struct{}),
		releaseRead: make(chan struct{}),
		secondRead:  make(chan struct{}),
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = reader
	permissionModeID := "acceptEdits"
	firstDone := make(chan error, 1)
	go func() {
		_, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
			PermissionModeID: &permissionModeID,
		})
		firstDone <- err
	}()
	<-reader.firstRead

	planMode := true
	secondStarted := make(chan struct{})
	secondDone := make(chan error, 1)
	go func() {
		close(secondStarted)
		_, err := service.UpdateSettings(context.Background(), "ws-1", "session-1", ComposerSettingsPatch{
			PlanMode: &planMode,
		})
		secondDone <- err
	}()
	<-secondStarted
	select {
	case <-reader.secondRead:
		t.Fatal("second historical settings read overlapped the first mutation")
	case <-time.After(50 * time.Millisecond):
	}
	close(reader.releaseRead)
	if err := <-firstDone; err != nil {
		t.Fatalf("first UpdateSettings returned error: %v", err)
	}
	if err := <-secondDone; err != nil {
		t.Fatalf("second UpdateSettings returned error: %v", err)
	}
	final, ok := reader.GetSession("ws-1", "session-1")
	if !ok || final.Settings.PermissionModeID != "acceptEdits" || !final.Settings.PlanMode {
		t.Fatalf("final settings = %#v ok=%v, want both patches", final.Settings, ok)
	}
}

type settingsUpdateSessionReader struct {
	*fakeSessionReader
	updateCalls     int
	updatedAtUnixMS int64
}

type blockingResumeRuntime struct {
	*fakeRuntime
	resumeEntered     chan RuntimeResumeInput
	resumeRelease     chan struct{}
	liveUpdateEntered chan RuntimeUpdateSettingsInput
}

func (r *blockingResumeRuntime) Resume(ctx context.Context, input RuntimeResumeInput) (ProviderRuntimeSession, error) {
	r.resumeEntered <- input
	select {
	case <-ctx.Done():
		return ProviderRuntimeSession{}, ctx.Err()
	case <-r.resumeRelease:
		return r.fakeRuntime.Resume(ctx, input)
	}
}

func (r *blockingResumeRuntime) UpdateSettings(ctx context.Context, input RuntimeUpdateSettingsInput) error {
	r.liveUpdateEntered <- input
	return r.fakeRuntime.UpdateSettings(ctx, input)
}

type serializedSettingsReader struct {
	*fakeSessionReader
	mu          sync.Mutex
	readCalls   int
	firstRead   chan struct{}
	releaseRead chan struct{}
	secondRead  chan struct{}
}

func (r *serializedSettingsReader) GetSession(workspaceID string, agentSessionID string) (PersistedSession, bool) {
	r.mu.Lock()
	r.readCalls++
	call := r.readCalls
	session, ok := r.sessions[workspaceID+":"+agentSessionID]
	r.mu.Unlock()
	switch call {
	case 1:
		close(r.firstRead)
		<-r.releaseRead
	case 2:
		close(r.secondRead)
	}
	return session, ok
}

func (r *serializedSettingsReader) UpdateSessionSettings(
	_ context.Context,
	workspaceID string,
	agentSessionID string,
	settings ComposerSettings,
) (PersistedSession, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	key := workspaceID + ":" + agentSessionID
	session, ok := r.sessions[key]
	if !ok {
		return PersistedSession{}, false, nil
	}
	session.Settings = settings
	r.sessions[key] = session
	return session, true, nil
}

func (r *settingsUpdateSessionReader) UpdateSessionSettings(
	_ context.Context,
	workspaceID string,
	agentSessionID string,
	settings ComposerSettings,
) (PersistedSession, bool, error) {
	key := workspaceID + ":" + agentSessionID
	session, ok := r.sessions[key]
	if !ok {
		return PersistedSession{}, false, nil
	}
	r.updateCalls++
	session.Settings = settings
	session.UpdatedAtUnixMS = r.updatedAtUnixMS
	r.sessions[key] = session
	return session, true, nil
}
