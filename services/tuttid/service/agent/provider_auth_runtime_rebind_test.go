package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func TestServiceCreateRecordsCurrentProviderRuntimeCredentialGeneration(t *testing.T) {
	service := newTestService(newFakeRuntime())
	service.InvalidateProviderRuntimeCredentials("cursor")
	wantGeneration := service.providerRuntimeCredentialGeneration("cursor")

	const sessionID = "11111111-1111-4111-8111-111111111112"
	result, err := service.Create(context.Background(), "workspace-1", CreateSessionInput{
		AgentSessionID: sessionID,
		AgentTargetID:  agenttargetbiz.IDLocalCursor,
		Provider:       "cursor",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if result.ID != sessionID {
		t.Fatalf("Create() session ID = %q, want %q", result.ID, sessionID)
	}

	key := providerRuntimeSessionAuthKey{workspaceID: "workspace-1", sessionID: sessionID}
	service.providerRuntimeAuthMu.Lock()
	got, ok := service.providerRuntimeSessionAuth[key]
	service.providerRuntimeAuthMu.Unlock()
	if !ok {
		t.Fatal("Create() did not record applied provider credential generation")
	}
	if got.provider != "cursor" || got.generation != wantGeneration {
		t.Fatalf("Create() auth generation = %#v, want cursor generation %d", got, wantGeneration)
	}
}

func TestServiceCreateFailureDoesNotRecordProviderRuntimeCredentialGeneration(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.startErr = errors.New("runtime start failed")
	service := newTestService(runtime)
	service.InvalidateProviderRuntimeCredentials("cursor")

	const sessionID = "11111111-1111-4111-8111-111111111113"
	if _, err := service.Create(context.Background(), "workspace-1", CreateSessionInput{
		AgentSessionID: sessionID,
		AgentTargetID:  agenttargetbiz.IDLocalCursor,
		Provider:       "cursor",
	}); err == nil {
		t.Fatal("Create() error = nil, want runtime start failure")
	}

	assertProviderRuntimeCredentialTrackingAbsent(t, service, "workspace-1", sessionID)
}

type cursorAuthFixtureRuntime struct {
	*fakeRuntime
	authMarker        string
	processGeneration string
	processes         []string
	execGenerations   []string
}

func newCursorAuthFixtureRuntime(t *testing.T, authMarker string, session ProviderRuntimeSession) *cursorAuthFixtureRuntime {
	t.Helper()
	runtime := &cursorAuthFixtureRuntime{
		fakeRuntime: newFakeRuntime(),
		authMarker:  authMarker,
	}
	runtime.sessions[session.WorkspaceID+":"+session.ID] = session
	runtime.launchProcess(t)
	return runtime
}

func (r *cursorAuthFixtureRuntime) launchProcess(t testing.TB) {
	t.Helper()
	content, err := os.ReadFile(r.authMarker)
	if err != nil {
		t.Fatalf("read Cursor auth generation: %v", err)
	}
	r.processGeneration = strings.TrimSpace(string(content))
	r.processes = append(r.processes, r.processGeneration)
}

func (r *cursorAuthFixtureRuntime) Reprepare(_ context.Context, input RuntimeResumeInput) (ProviderRuntimeSession, error) {
	content, err := os.ReadFile(r.authMarker)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	r.processGeneration = strings.TrimSpace(string(content))
	r.processes = append(r.processes, r.processGeneration)
	return r.Resume(context.Background(), input)
}

func (r *cursorAuthFixtureRuntime) Exec(ctx context.Context, input RuntimeExecInput) (RuntimeExecResult, error) {
	r.execGenerations = append(r.execGenerations, r.processGeneration)
	return r.fakeRuntime.Exec(ctx, input)
}

func TestCursorAuthChangeRepreparesIdleCanonicalSessionBeforeNextSend(t *testing.T) {
	dir := t.TempDir()
	authMarker := filepath.Join(dir, "cli-config.json")
	if err := os.WriteFile(authMarker, []byte("free"), 0o600); err != nil {
		t.Fatalf("write initial Cursor auth generation: %v", err)
	}
	session := ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "ws-1", AgentTargetID: "local:cursor",
		Provider: "cursor", ProviderSessionID: "cursor-thread-1", Resumable: true,
		Cwd: dir, Status: "ready", CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
	}
	runtime := newCursorAuthFixtureRuntime(t, authMarker, session)
	service := newTestService(runtime)
	service.SessionReader = &fakeSessionReader{sessions: map[string]PersistedSession{
		"ws-1:session-1": {
			ID: session.ID, WorkspaceID: session.WorkspaceID, AgentTargetID: session.AgentTargetID,
			Provider: session.Provider, ProviderSessionID: session.ProviderSessionID,
			Cwd: session.Cwd, RailSectionKey: "conversations", CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
		},
	}}
	staged := filepath.Join(dir, "cli-config.next.json")
	if err := os.WriteFile(staged, []byte("pro"), 0o600); err != nil {
		t.Fatalf("write staged Cursor auth generation: %v", err)
	}
	if err := os.Rename(staged, authMarker); err != nil {
		// Windows does not guarantee replacement of an existing file through
		// os.Rename. Credential switchers may remove then rename instead.
		if removeErr := os.Remove(authMarker); removeErr != nil {
			t.Fatalf("remove old Cursor auth marker after rename failure %v: %v", err, removeErr)
		}
		if renameErr := os.Rename(staged, authMarker); renameErr != nil {
			t.Fatalf("rename staged Cursor auth marker: %v", renameErr)
		}
	}
	service.InvalidateProviderRuntimeCredentials("cursor")

	if _, err := service.SendInput(context.Background(), "ws-1", "session-1", SendInput{
		Content: TextPromptContent("use my Pro account"),
	}); err != nil {
		t.Fatalf("SendInput after Cursor relogin: %v", err)
	}
	if got := runtime.execGenerations; len(got) != 1 || got[0] != "pro" {
		t.Fatalf("exec auth generations = %v, want [pro] from replacement process", got)
	}
	if got := runtime.processes; len(got) != 2 || got[0] != "free" || got[1] != "pro" {
		t.Fatalf("process auth generations = %v, want [free pro]", got)
	}
	if got := runtime.resumeCalls; len(got) != 1 || got[0].AgentSessionID != "session-1" || got[0].ProviderSessionID != "cursor-thread-1" {
		t.Fatalf("reprepare resume calls = %#v, want same canonical/provider session identity", got)
	}
}

func TestCursorAuthChangeDoesNotInterruptActiveTurnAndRetriesWhenIdle(t *testing.T) {
	dir := t.TempDir()
	authMarker := filepath.Join(dir, "cli-config.json")
	if err := os.WriteFile(authMarker, []byte("free"), 0o600); err != nil {
		t.Fatalf("write initial Cursor auth generation: %v", err)
	}
	session := ProviderRuntimeSession{
		ID: "session-active", WorkspaceID: "ws-1", AgentTargetID: "local:cursor",
		Provider: "cursor", ProviderSessionID: "cursor-thread-active", Resumable: true,
		Cwd: dir, Status: "working", CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
	}
	runtime := newCursorAuthFixtureRuntime(t, authMarker, session)
	service := newTestService(runtime)
	reader := &fakeSessionReader{sessions: map[string]PersistedSession{
		"ws-1:session-active": {
			ID: session.ID, WorkspaceID: session.WorkspaceID, AgentTargetID: session.AgentTargetID,
			Provider: session.Provider, ProviderSessionID: session.ProviderSessionID,
			Cwd: session.Cwd, RailSectionKey: "conversations", ActiveTurnID: "turn-active",
			CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
		},
	}}
	service.SessionReader = reader
	if err := os.WriteFile(authMarker, []byte("pro"), 0o600); err != nil {
		t.Fatalf("write replacement Cursor auth generation: %v", err)
	}
	service.InvalidateProviderRuntimeCredentials("cursor")

	_, err := service.SendInput(context.Background(), "ws-1", "session-active", SendInput{
		Content: TextPromptContent("do not interrupt"),
	})
	if !errors.Is(err, agenthost.ErrRuntimeSessionActive) {
		t.Fatalf("SendInput during active Turn error = %v, want ErrRuntimeSessionActive", err)
	}
	if len(runtime.processes) != 1 || len(runtime.execGenerations) != 0 {
		t.Fatalf("active Turn changed process/exec state: processes=%v exec=%v", runtime.processes, runtime.execGenerations)
	}

	persisted := reader.sessions["ws-1:session-active"]
	persisted.ActiveTurnID = ""
	reader.sessions["ws-1:session-active"] = persisted
	if _, err := service.SendInput(context.Background(), "ws-1", "session-active", SendInput{
		Content: TextPromptContent("retry while idle"),
	}); err != nil {
		t.Fatalf("SendInput after Turn became idle: %v", err)
	}
	if got := runtime.execGenerations; len(got) != 1 || got[0] != "pro" {
		t.Fatalf("idle retry exec auth generations = %v, want [pro]", got)
	}
}

func TestProviderAuthChangeDoesNotReprepareOtherProviderSession(t *testing.T) {
	dir := t.TempDir()
	authMarker := filepath.Join(dir, "cli-config.json")
	if err := os.WriteFile(authMarker, []byte("free"), 0o600); err != nil {
		t.Fatalf("write Cursor auth generation: %v", err)
	}
	session := ProviderRuntimeSession{
		ID: "session-cursor", WorkspaceID: "ws-1", AgentTargetID: "local:cursor",
		Provider: "cursor", ProviderSessionID: "cursor-thread-1", Resumable: true,
		Cwd: dir, Status: "ready", CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
	}
	runtime := newCursorAuthFixtureRuntime(t, authMarker, session)
	service := newTestService(runtime)
	service.SessionReader = &fakeSessionReader{sessions: map[string]PersistedSession{
		"ws-1:session-cursor": {
			ID: session.ID, WorkspaceID: session.WorkspaceID, AgentTargetID: session.AgentTargetID,
			Provider: session.Provider, ProviderSessionID: session.ProviderSessionID,
			Cwd: session.Cwd, RailSectionKey: "conversations", CreatedAtUnixMS: 1, UpdatedAtUnixMS: 2,
		},
	}}
	service.InvalidateProviderRuntimeCredentials("codex")

	if _, err := service.SendInput(context.Background(), "ws-1", "session-cursor", SendInput{
		Content: TextPromptContent("keep Cursor process"),
	}); err != nil {
		t.Fatalf("SendInput after unrelated auth change: %v", err)
	}
	if got := runtime.processes; len(got) != 1 || got[0] != "free" {
		t.Fatalf("Cursor processes = %v, want unchanged [free]", got)
	}
}

func TestProviderRuntimeCredentialGenerationChangedDuringReprepareStaysStale(t *testing.T) {
	service := &Service{}
	service.InvalidateProviderRuntimeCredentials("cursor")
	generation, needed := service.providerRuntimeCredentialsNeedReprepare("ws", "session", "cursor")
	if generation != 1 || !needed {
		t.Fatalf("initial stale state = (%d, %v), want (1, true)", generation, needed)
	}
	service.InvalidateProviderRuntimeCredentials("cursor")
	service.markProviderRuntimeCredentialsApplied("ws", "session", "cursor", generation)
	nextGeneration, stillNeeded := service.providerRuntimeCredentialsNeedReprepare("ws", "session", "cursor")
	if nextGeneration != 2 || !stillNeeded {
		t.Fatalf("concurrent auth change state = (%d, %v), want (2, true)", nextGeneration, stillNeeded)
	}
}
