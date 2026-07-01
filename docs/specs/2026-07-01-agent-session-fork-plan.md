# Agent Session Fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build provider-backed Codex agent session fork in Tutti, with durable fork lineage, child session history, API/client integration, and Agent GUI entry points.

**Architecture:** The Codex app-server `thread/fork` RPC is the source of truth for child provider sessions. tuttid wraps that provider fork in a service-level saga that creates a child `workspace_agent_sessions` row, persists lineage in a dedicated table, seeds child messages, and publishes activity updates. Agent GUI calls the new tuttid fork endpoint through the existing `AgentActivityRuntime` and activates the returned child session.

**Tech Stack:** Go tuttid daemon, SQLite workspace store, oapi-codegen OpenAPI server types, generated TypeScript tuttid client, React/TypeScript Agent GUI, Vitest, Go tests.

---

## File Structure

- `services/tuttid/data/workspace/migrations.go`
  - Add the `workspace_agent_session_forks` schema migration.
- `services/tuttid/biz/agentactivity/activity.go`
  - Add the durable fork lineage value type used by storage and service layers.
- `services/tuttid/data/workspace/sqlite_agent_session_forks.go`
  - New repository methods for creating and reading fork lineage.
- `services/tuttid/data/workspace/sqlite_agent_session_forks_test.go`
  - Storage tests for migration, insertion, idempotency, and parent lookup.
- `services/tuttid/service/agent/session_types.go`
  - Add service/runtime fork input, result, lineage, and repository interfaces.
- `services/tuttid/service/agent/service_fork.go`
  - New service orchestration for fork validation, title generation, runtime fork, persistence, and message seeding.
- `services/tuttid/service/agent/service_fork_test.go`
  - Service tests for provider validation, title rules, idempotency, turn boundaries, and persistence failure.
- `packages/agent/daemon/runtime/types.go`
  - Add runtime-level `ForkInput`, `ForkResult`, and fork lineage/message types.
- `packages/agent/daemon/runtime/adapter.go`
  - Extend adapter interface with optional fork capability.
- `packages/agent/daemon/runtime/controller.go`
  - Add `Controller.Fork`.
- `packages/agent/daemon/runtime/codex_appserver_adapter.go`
  - Implement Codex `thread/fork`.
- `packages/agent/daemon/runtime/codex_appserver_adapter_test.go`
  - Runtime tests for `thread/fork` request/response mapping.
- `services/tuttid/api/openapi/tuttid.v1.yaml`
  - Add fork endpoint and schemas.
- `services/tuttid/api/daemon_agent_sessions.go`
  - Extend `AgentSessionService` interface and wire the generated handler.
- `services/tuttid/api/daemon_agent_sessions_fork.go`
  - New API transform/error mapping helpers.
- `services/tuttid/api/daemon_agent_sessions_fork_test.go`
  - API tests for success and error mapping.
- Generated files from `pnpm generate:api`
  - `services/tuttid/api/generated/types.gen.go`
  - `packages/clients/tuttid-ts/src/generated/**`
- `packages/agent/activity-core/src/types.ts`
  - Add adapter/runtime fork request and result contracts.
- `packages/agent/activity-core/src/adapter.ts`
  - Extend `AgentActivityAdapter` with the fork method.
- `packages/clients/tuttid-ts/src/tuttidClient.ts`
  - Wrap the generated fork SDK call in the handwritten client facade.
- `packages/clients/tuttid-ts/src/tuttidClientTypes.ts`
  - Add the fork method to `TuttidClient`.
- `packages/clients/tuttid-ts/src/index.test.ts`
  - Cover the client wrapper path and request shape.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts`
  - Call the generated tuttid client fork method and map the response.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts`
  - Add service method that delegates to the adapter and refreshes activity state.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/workspaceAgentActivityService.interface.ts`
  - Add fork service interface.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts`
  - Expose `forkSession` to Agent GUI.
- `packages/agent/gui/agentActivityRuntime.tsx`
  - Add `forkSession` to the runtime interface.
- `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts`
  - Add actions for conversation-level and turn-level fork.
- `packages/agent/gui/agent-gui/agentGuiNode/AgentSessionChrome.tsx`
  - Add menu item and parent indicator.
- `packages/agent/gui/agent-gui/agentGuiNode/agentGuiNodeViewConversation.tsx`
  - Add turn/message action hook for `Fork from here`.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.test.ts`
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.test.ts`
- `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx`
- `packages/agent/gui/agent-gui/agentGuiNode/AgentSessionChrome.spec.tsx`
- `packages/agent/gui/agent-gui/agentGuiNode/agentGuiNodeViewConversation.spec.ts`

## Task 1: Storage Lineage Table

**Files:**

- Modify: `services/tuttid/data/workspace/migrations.go`
- Modify: `services/tuttid/biz/agentactivity/activity.go`
- Create: `services/tuttid/data/workspace/sqlite_agent_session_forks.go`
- Create: `services/tuttid/data/workspace/sqlite_agent_session_forks_test.go`

- [ ] **Step 1: Write failing migration/repository tests**

Add tests covering table creation, insert, idempotent request lookup, and parent lookup:

```go
func TestSQLiteStoreAgentSessionForks(t *testing.T) {
	ctx := context.Background()
	store := newTestSQLiteStore(t)
	mustCreateWorkspace(t, store, "ws-forks")
	mustReportAgentSession(t, store, "ws-forks", "parent", "codex", "thread-parent")

	input := agentactivitybiz.ForkLineage{
		WorkspaceID:             "ws-forks",
		ChildAgentSessionID:     "child",
		ParentAgentSessionID:    "parent",
		ChildProviderSessionID:  "thread-child",
		ParentProviderSessionID: "thread-parent",
		Provider:                "codex",
		ForkTurnID:              "turn-1",
		ForkRequestID:           "request-1",
		ForkedAtUnixMS:          1782892800000,
	}

	if err := store.InsertAgentSessionFork(ctx, input); err != nil {
		t.Fatalf("InsertAgentSessionFork: %v", err)
	}
	got, ok, err := store.GetAgentSessionForkByRequestID(ctx, "ws-forks", "request-1")
	if err != nil || !ok {
		t.Fatalf("GetAgentSessionForkByRequestID = ok %v err %v", ok, err)
	}
	if got.ChildAgentSessionID != "child" || got.ParentAgentSessionID != "parent" {
		t.Fatalf("lineage = %#v", got)
	}
	children, err := store.ListAgentSessionForksByParent(ctx, "ws-forks", "parent")
	if err != nil {
		t.Fatalf("ListAgentSessionForksByParent: %v", err)
	}
	if len(children) != 1 || children[0].ChildAgentSessionID != "child" {
		t.Fatalf("children = %#v", children)
	}
}
```

- [ ] **Step 2: Run storage test and verify it fails**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti/services/tuttid
go test ./data/workspace -run TestSQLiteStoreAgentSessionForks -count=1
```

Expected: FAIL because the repository methods/types do not exist.

- [ ] **Step 3: Add migration constants and SQL**

Add the lineage value type to `services/tuttid/biz/agentactivity/activity.go`:

```go
type ForkLineage struct {
	WorkspaceID              string
	ChildAgentSessionID      string
	ParentAgentSessionID     string
	ChildProviderSessionID   string
	ParentProviderSessionID  string
	Provider                 string
	ForkTurnID               string
	ForkRequestID            string
	ForkedAtUnixMS           int64
}
```

Add a new migration id after the current workspace agent activity migrations:

```go
const schemaMigrationWorkspaceAgentSessionForks = "workspace_agent_session_forks_v1"
```

Add migration SQL:

```go
CREATE TABLE IF NOT EXISTS workspace_agent_session_forks (
  workspace_id TEXT NOT NULL,
  child_agent_session_id TEXT NOT NULL,
  parent_agent_session_id TEXT NOT NULL,
  child_provider_session_id TEXT NOT NULL DEFAULT '',
  parent_provider_session_id TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  fork_turn_id TEXT NOT NULL DEFAULT '',
  fork_request_id TEXT NOT NULL DEFAULT '',
  forked_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, child_agent_session_id),
  UNIQUE (workspace_id, fork_request_id),
  FOREIGN KEY (workspace_id, child_agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id)
    ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, parent_agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_agent_session_forks_parent
  ON workspace_agent_session_forks(workspace_id, parent_agent_session_id);
```

- [ ] **Step 4: Add repository model and methods**

Create `sqlite_agent_session_forks.go`:

```go
package workspace

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func (s *SQLiteStore) InsertAgentSessionFork(ctx context.Context, fork agentactivitybiz.ForkLineage) error {
	if strings.TrimSpace(fork.WorkspaceID) == "" ||
		strings.TrimSpace(fork.ChildAgentSessionID) == "" ||
		strings.TrimSpace(fork.ParentAgentSessionID) == "" ||
		strings.TrimSpace(fork.ForkRequestID) == "" {
		return fmt.Errorf("workspace id, child session id, parent session id, and fork request id are required")
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO workspace_agent_session_forks (
  workspace_id, child_agent_session_id, parent_agent_session_id,
  child_provider_session_id, parent_provider_session_id, provider,
  fork_turn_id, fork_request_id, forked_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
		strings.TrimSpace(fork.WorkspaceID),
		strings.TrimSpace(fork.ChildAgentSessionID),
		strings.TrimSpace(fork.ParentAgentSessionID),
		strings.TrimSpace(fork.ChildProviderSessionID),
		strings.TrimSpace(fork.ParentProviderSessionID),
		strings.TrimSpace(fork.Provider),
		strings.TrimSpace(fork.ForkTurnID),
		strings.TrimSpace(fork.ForkRequestID),
		fork.ForkedAtUnixMS,
	)
	if err != nil {
		return fmt.Errorf("insert workspace agent session fork: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetAgentSessionForkByRequestID(ctx context.Context, workspaceID string, requestID string) (agentactivitybiz.ForkLineage, bool, error) {
	return s.scanAgentSessionFork(ctx, `
SELECT workspace_id, child_agent_session_id, parent_agent_session_id,
       child_provider_session_id, parent_provider_session_id, provider,
       fork_turn_id, fork_request_id, forked_at_unix_ms
FROM workspace_agent_session_forks
WHERE workspace_id = ? AND fork_request_id = ?;`,
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(requestID),
	)
}

func (s *SQLiteStore) ListAgentSessionForksByParent(ctx context.Context, workspaceID string, parentAgentSessionID string) ([]agentactivitybiz.ForkLineage, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT workspace_id, child_agent_session_id, parent_agent_session_id,
       child_provider_session_id, parent_provider_session_id, provider,
       fork_turn_id, fork_request_id, forked_at_unix_ms
FROM workspace_agent_session_forks
WHERE workspace_id = ? AND parent_agent_session_id = ?
ORDER BY forked_at_unix_ms ASC, child_agent_session_id ASC;`,
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(parentAgentSessionID),
	)
	if err != nil {
		return nil, fmt.Errorf("list workspace agent session forks by parent: %w", err)
	}
	defer rows.Close()
	out := []agentactivitybiz.ForkLineage{}
	for rows.Next() {
		fork, err := scanAgentSessionForkRow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, fork)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace agent session forks: %w", err)
	}
	return out, nil
}

func (s *SQLiteStore) scanAgentSessionFork(ctx context.Context, query string, args ...any) (agentactivitybiz.ForkLineage, bool, error) {
	row := s.db.QueryRowContext(ctx, query, args...)
	fork, err := scanAgentSessionForkRow(row)
	if err == sql.ErrNoRows {
		return agentactivitybiz.ForkLineage{}, false, nil
	}
	if err != nil {
		return agentactivitybiz.ForkLineage{}, false, err
	}
	return fork, true, nil
}

type agentSessionForkScanner interface {
	Scan(dest ...any) error
}

func scanAgentSessionForkRow(row agentSessionForkScanner) (agentactivitybiz.ForkLineage, error) {
	var fork agentactivitybiz.ForkLineage
	if err := row.Scan(
		&fork.WorkspaceID,
		&fork.ChildAgentSessionID,
		&fork.ParentAgentSessionID,
		&fork.ChildProviderSessionID,
		&fork.ParentProviderSessionID,
		&fork.Provider,
		&fork.ForkTurnID,
		&fork.ForkRequestID,
		&fork.ForkedAtUnixMS,
	); err != nil {
		return agentactivitybiz.ForkLineage{}, fmt.Errorf("scan workspace agent session fork: %w", err)
	}
	return fork, nil
}
```

- [ ] **Step 5: Run storage tests**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti/services/tuttid
go test ./data/workspace -run 'TestSQLiteStoreAgentSessionForks|TestSQLiteStoreMigrations' -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit storage changes**

```bash
cd /Users/chovy/Desktop/workspace/tutti
git add services/tuttid/data/workspace/migrations.go services/tuttid/data/workspace/sqlite_agent_session_forks.go services/tuttid/data/workspace/sqlite_agent_session_forks_test.go services/tuttid/biz/agentactivity
git commit -m "feat(agent): persist agent session fork lineage"
```

## Task 2: Runtime Fork Contract And Codex Adapter

**Files:**

- Modify: `packages/agent/daemon/runtime/types.go`
- Modify: `packages/agent/daemon/runtime/adapter.go`
- Modify: `packages/agent/daemon/runtime/controller.go`
- Modify: `packages/agent/daemon/runtime/codex_appserver_adapter.go`
- Modify: `packages/agent/daemon/runtime/codex_appserver_adapter_test.go`

- [ ] **Step 1: Write failing Codex adapter tests**

Add tests:

```go
func TestCodexAppServerAdapterFork(t *testing.T) {
	transport := newScriptedAppServerTransport()
	adapter := NewCodexAppServerAdapter(transport)
	parent := testAppServerSession()
	parent.AgentSessionID = "parent-session"
	parent.ProviderSessionID = "thread-parent"

	result, err := adapter.Fork(context.Background(), ForkInput{
		Source:               parent,
		TargetAgentSessionID: "child-session",
		LastTurnID:           "turn-1",
	})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	request := appServerRequestParams(t, transport.conn, appServerMethodThreadFork)
	if request["threadId"] != "thread-parent" {
		t.Fatalf("threadId = %#v, want thread-parent", request["threadId"])
	}
	if request["lastTurnId"] != "turn-1" {
		t.Fatalf("lastTurnId = %#v, want turn-1", request["lastTurnId"])
	}
	if result.Session.AgentSessionID != "child-session" {
		t.Fatalf("child session id = %q", result.Session.AgentSessionID)
	}
	if result.Session.ProviderSessionID == "" || result.Session.ProviderSessionID == "thread-parent" {
		t.Fatalf("child provider session id = %q", result.Session.ProviderSessionID)
	}
}
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti/packages/agent/daemon
go test ./runtime -run TestCodexAppServerAdapterFork -count=1
```

Expected: FAIL because `Fork` types/methods do not exist.

- [ ] **Step 3: Add runtime types**

Add to `packages/agent/daemon/runtime/types.go`:

```go
type ForkInput struct {
	Source               Session
	TargetAgentSessionID string
	LastTurnID           string
	Title                string
	Visible              *bool
}

type ForkLineage struct {
	SourceAgentSessionID     string `json:"sourceAgentSessionId"`
	TargetAgentSessionID     string `json:"targetAgentSessionId"`
	SourceProviderSessionID  string `json:"sourceProviderSessionId"`
	TargetProviderSessionID  string `json:"targetProviderSessionId"`
	Provider                 string `json:"provider"`
	LastTurnID               string `json:"lastTurnId,omitempty"`
	ForkedAtUnixMS           int64  `json:"forkedAtUnixMs"`
}

type ForkResult struct {
	Session Session     `json:"session"`
	Events  []Event     `json:"events,omitempty"`
	Fork    ForkLineage `json:"fork"`
}
```

- [ ] **Step 4: Add optional adapter interface and controller method**

Add to `adapter.go`:

```go
type ForkAdapter interface {
	Fork(context.Context, ForkInput) (ForkResult, error)
}
```

Add to `controller.go`:

```go
func (c *Controller) Fork(ctx context.Context, input ForkInput) (ForkResult, error) {
	c.startMu.Lock()
	defer c.startMu.Unlock()
	source := input.Source
	if strings.TrimSpace(source.RoomID) == "" ||
		strings.TrimSpace(source.AgentSessionID) == "" ||
		strings.TrimSpace(source.Provider) == "" {
		return ForkResult{}, fmt.Errorf("source session is required")
	}
	adapter := c.adapter(source.Provider)
	forkAdapter, ok := adapter.(ForkAdapter)
	if !ok || forkAdapter == nil {
		return ForkResult{}, fmt.Errorf("agent session fork is unsupported for provider %q", source.Provider)
	}
	result, err := forkAdapter.Fork(ctx, input)
	if err != nil {
		return ForkResult{}, err
	}
	c.mu.Lock()
	c.sessions[sessionKey(result.Session.RoomID, result.Session.AgentSessionID)] = result.Session
	c.mu.Unlock()
	c.publish(result.Session, result.Events)
	c.enqueueSessionReport(ctx, result.Session, result.Events)
	return result, nil
}
```

- [ ] **Step 5: Implement Codex `thread/fork`**

Add `Fork` near `Resume` in `codex_appserver_adapter.go`:

```go
func (a *CodexAppServerAdapter) Fork(ctx context.Context, input ForkInput) (result ForkResult, err error) {
	source := input.Source
	if strings.TrimSpace(source.ProviderSessionID) == "" {
		return ForkResult{}, missingProviderSessionResumeError(source)
	}
	target := source
	target.AgentSessionID = strings.TrimSpace(input.TargetAgentSessionID)
	if target.AgentSessionID == "" {
		return ForkResult{}, fmt.Errorf("target agent session id is required")
	}
	if strings.TrimSpace(input.Title) != "" {
		target.Title = strings.TrimSpace(input.Title)
	}
	if input.Visible != nil {
		target.Visible = *input.Visible
	}
	target.ProviderSessionID = ""

	trace := newCodexAppServerStartupTrace(target)
	defer func() { trace.Finish(err) }()
	client, initializeResult, err := a.startInitializedClient(ctx, target, trace)
	if err != nil {
		return ForkResult{}, err
	}
	started := false
	defer func() {
		if !started {
			_ = client.Close()
			a.removeSession(target.AgentSessionID)
		}
	}()
	serverInfo := appServerInfo(initializeResult)
	account, authRequired := a.fetchAccount(ctx, client, target, trace)
	if authRequired {
		return ForkResult{}, fmt.Errorf(codexAppServerAuthRequiredMessage)
	}
	models := []map[string]any(nil)
	if codexAppServerNeedsSynchronousModels(target) {
		models = a.fetchModels(ctx, client, target, trace)
	}
	planModeMask := a.fetchPlanCollaborationMode(ctx, client, target, trace)

	params := appServerThreadStartParams(target, a.sessionCWD(target))
	params["threadId"] = strings.TrimSpace(source.ProviderSessionID)
	if lastTurnID := strings.TrimSpace(input.LastTurnID); lastTurnID != "" {
		params["lastTurnId"] = lastTurnID
	}
	threadResult, err := trace.Call(ctx, client, acpStartCallTimeout, appServerMethodThreadFork, params,
		func(ctx context.Context, message acpMessage) error {
			trace.LogMessage(message.Method, len(message.ID) > 0, len(message.Params))
			_, err := a.handleAppServerMessage(ctx, client, target, "", message, nil, nil, nil)
			return err
		})
	if err != nil {
		return ForkResult{}, classifyACPResumeError(source, appServerMethodThreadFork, err)
	}
	threadID, err := appServerThreadID(threadResult)
	if err != nil {
		return ForkResult{}, err
	}
	target.ProviderSessionID = threadID
	target.Status = SessionStatusReady
	target.CreatedAtUnixMS = unixMS(now())
	target.UpdatedAtUnixMS = target.CreatedAtUnixMS

	liveState := newACPLiveState()
	liveState.currentMode = codexACPEffectiveModeID(target)
	liveState.availableCommands = codexAppServerCommands()
	liveState.commandsKnown = true
	applyACPConfigOptionDescriptors(&liveState, codexAppServerConfigOptionDescriptors(models, target, threadResult))
	started = true
	a.storeSession(target.AgentSessionID, &codexAppServerSession{
		client:                 client,
		threadID:               threadID,
		serverInfo:             serverInfo,
		account:                account,
		startupModelsReady:     len(models) > 0,
		startupRateLimitsReady: false,
		planModeMask:           planModeMask,
		defaultModel:           codexAppServerSessionDefaultModel(target, models),
		authState:              "authenticated",
		acpLiveState:           liveState,
		pendingRequests:        make(map[string]*pendingACPRequest),
	})
	events := []Event{newSessionActivityEvent(target, EventSessionStarted, SessionStatusReady, map[string]any{
		"adapter":          a.commandString(),
		"command":          a.commandString(),
		"agent":            serverInfo,
		"permissionModeId": target.PermissionModeID,
	})}
	return ForkResult{
		Session: target,
		Events:  events,
		Fork: ForkLineage{
			SourceAgentSessionID:    source.AgentSessionID,
			TargetAgentSessionID:    target.AgentSessionID,
			SourceProviderSessionID: source.ProviderSessionID,
			TargetProviderSessionID: target.ProviderSessionID,
			Provider:                ProviderCodex,
			LastTurnID:              strings.TrimSpace(input.LastTurnID),
			ForkedAtUnixMS:          target.CreatedAtUnixMS,
		},
	}, nil
}
```

- [ ] **Step 6: Run runtime tests**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti/packages/agent/daemon
go test ./runtime -run 'TestCodexAppServerAdapterFork|TestCodexAppServerAdapterResume|TestController' -count=1
```

Expected: PASS.

- [ ] **Step 7: Commit runtime changes**

```bash
cd /Users/chovy/Desktop/workspace/tutti
git add packages/agent/daemon/runtime
git commit -m "feat(agent): fork codex runtime sessions"
```

## Task 3: tuttid Agent Service Fork

**Files:**

- Modify: `services/tuttid/service/agent/session_types.go`
- Create: `services/tuttid/service/agent/service_fork.go`
- Create: `services/tuttid/service/agent/service_fork_test.go`

- [ ] **Step 1: Write failing service tests**

Add tests:

```go
func TestServiceForkCreatesChildSessionWithGeneratedTitle(t *testing.T) {
	ctx := context.Background()
	runtime := newFakeRuntimeController()
	store := newFakeForkStore()
	service := NewService(runtime)
	service.SessionReader = store
	service.MessageReader = store
	service.ForkStore = store

	store.sessions["parent"] = PersistedSession{
		ID:                "parent",
		WorkspaceID:       "ws-1",
		Provider:          "codex",
		ProviderSessionID: "thread-parent",
		Title:             "Build login",
		Status:            "completed",
		Visible:           true,
	}
	runtime.forkResult = RuntimeForkResult{
		Session: RuntimeSession{
			ID:                "child",
			WorkspaceID:       "ws-1",
			Provider:          "codex",
			ProviderSessionID: "thread-child",
			Title:             "Build login(fork1)",
			Status:            "ready",
			Visible:           true,
			CreatedAtUnixMS:   1782892800000,
			UpdatedAtUnixMS:   1782892800000,
		},
		Fork: RuntimeForkLineage{
			SourceAgentSessionID:    "parent",
			TargetAgentSessionID:    "child",
			SourceProviderSessionID: "thread-parent",
			TargetProviderSessionID: "thread-child",
			Provider:                "codex",
			ForkedAtUnixMS:          1782892800000,
		},
	}

	result, err := service.Fork(ctx, "ws-1", "parent", ForkSessionInput{
		RequestID:            "request-1",
		TargetAgentSessionID: "child",
	})
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}
	if title := value(result.Session.Title); title != "Build login(fork1)" {
		t.Fatalf("title = %q", title)
	}
	if result.Fork.TargetProviderSessionID != "thread-child" {
		t.Fatalf("fork = %#v", result.Fork)
	}
}
```

- [ ] **Step 2: Run service test and verify it fails**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti/services/tuttid
go test ./service/agent -run TestServiceForkCreatesChildSessionWithGeneratedTitle -count=1
```

Expected: FAIL because service fork types/methods do not exist.

- [ ] **Step 3: Add service types and interfaces**

Add to `session_types.go`:

```go
type ForkSessionInput struct {
	RequestID            string
	TargetAgentSessionID string
	LastTurnID           string
	Title                *string
	Visible              *bool
	Settings             *ComposerSettingsPatch
}

type ForkLineage struct {
	SourceAgentSessionID     string
	TargetAgentSessionID     string
	SourceProviderSessionID  string
	TargetProviderSessionID  string
	Provider                 string
	LastTurnID               string
	ForkedAtUnixMS           int64
}

type ForkSessionResult struct {
	Session Session
	Fork    ForkLineage
}

type ForkStore interface {
	InsertAgentSessionFork(context.Context, agentactivitybiz.ForkLineage) error
	GetAgentSessionForkByRequestID(context.Context, string, string) (agentactivitybiz.ForkLineage, bool, error)
	ListAgentSessionForksByParent(context.Context, string, string) ([]agentactivitybiz.ForkLineage, error)
}
```

Add `ForkStore ForkStore` to `Service`.

Add runtime types:

```go
type RuntimeForkInput struct {
	WorkspaceID             string
	SourceAgentSessionID    string
	TargetAgentSessionID    string
	Provider                string
	SourceProviderSessionID string
	Cwd                     string
	Settings                ComposerSettings
	LastTurnID              string
	Title                   string
	Visible                 *bool
}

type RuntimeForkLineage struct {
	SourceAgentSessionID    string
	TargetAgentSessionID    string
	SourceProviderSessionID string
	TargetProviderSessionID string
	Provider                string
	LastTurnID              string
	ForkedAtUnixMS          int64
}

type RuntimeForkResult struct {
	Session RuntimeSession
	Fork    RuntimeForkLineage
}
```

Extend `RuntimeController`:

```go
Fork(context.Context, RuntimeForkInput) (RuntimeForkResult, error)
```

- [ ] **Step 4: Implement service fork orchestration**

Create `service_fork.go` with:

```go
package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

var (
	ErrForkUnsupportedProvider      = errors.New("agent session fork is unsupported for provider")
	ErrForkProviderSessionMissing   = errors.New("agent session fork provider session id is missing")
	ErrForkRequestConflict          = errors.New("agent session fork request conflicts with existing fork")
)

func (s *Service) Fork(ctx context.Context, workspaceID string, sourceAgentSessionID string, input ForkSessionInput) (ForkSessionResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	sourceAgentSessionID = strings.TrimSpace(sourceAgentSessionID)
	requestID := strings.TrimSpace(input.RequestID)
	if workspaceID == "" || sourceAgentSessionID == "" || requestID == "" {
		return ForkSessionResult{}, ErrInvalidArgument
	}
	if s.ForkStore == nil || s.SessionReader == nil {
		return ForkSessionResult{}, ErrSessionNotFound
	}
	if existing, ok, err := s.ForkStore.GetAgentSessionForkByRequestID(ctx, workspaceID, requestID); err != nil {
		return ForkSessionResult{}, err
	} else if ok {
		session, err := s.Get(ctx, workspaceID, existing.ChildAgentSessionID)
		if err != nil {
			return ForkSessionResult{}, err
		}
		return ForkSessionResult{Session: session, Fork: serviceForkLineage(existing)}, nil
	}
	parent, ok := s.SessionReader.GetSession(workspaceID, sourceAgentSessionID)
	if !ok {
		return ForkSessionResult{}, ErrSessionNotFound
	}
	if strings.TrimSpace(parent.Provider) != "codex" {
		return ForkSessionResult{}, ErrForkUnsupportedProvider
	}
	if strings.TrimSpace(parent.ProviderSessionID) == "" {
		return ForkSessionResult{}, ErrForkProviderSessionMissing
	}
	targetID := strings.TrimSpace(input.TargetAgentSessionID)
	if targetID == "" {
		targetID = uuid.NewString()
	}
	title := strings.TrimSpace(value(input.Title))
	if title == "" {
		title = s.nextForkTitle(ctx, workspaceID, parent)
	}
	runtimeResult, err := s.controller().Fork(ctx, RuntimeForkInput{
		WorkspaceID:             workspaceID,
		SourceAgentSessionID:    parent.ID,
		TargetAgentSessionID:    targetID,
		Provider:                parent.Provider,
		SourceProviderSessionID: parent.ProviderSessionID,
		Cwd:                     parent.Cwd,
		Settings:                parent.Settings,
		LastTurnID:              strings.TrimSpace(input.LastTurnID),
		Title:                   title,
		Visible:                 input.Visible,
	})
	if err != nil {
		return ForkSessionResult{}, normalizeRuntimeError(err)
	}
	forkedAt := firstNonZeroInt64(runtimeResult.Fork.ForkedAtUnixMS, time.Now().UnixMilli())
	lineage := agentactivitybiz.ForkLineage{
		WorkspaceID:              workspaceID,
		ChildAgentSessionID:      runtimeResult.Session.ID,
		ParentAgentSessionID:     parent.ID,
		ChildProviderSessionID:   runtimeResult.Session.ProviderSessionID,
		ParentProviderSessionID:  parent.ProviderSessionID,
		Provider:                 parent.Provider,
		ForkTurnID:               strings.TrimSpace(input.LastTurnID),
		ForkRequestID:            requestID,
		ForkedAtUnixMS:           forkedAt,
	}
	if err := s.ForkStore.InsertAgentSessionFork(ctx, lineage); err != nil {
		return ForkSessionResult{}, fmt.Errorf("%w: %v", ErrForkRequestConflict, err)
	}
	session := serviceSession(runtimeResult.Session, s.controller().CanResume(runtimeResumeInputFromRuntimeSession(runtimeResult.Session)))
	return ForkSessionResult{Session: session, Fork: serviceForkLineage(lineage)}, nil
}
```

Include helpers `nextForkTitle`, `directForkNumberFromLineage`, and `serviceForkLineage`.

- [ ] **Step 5: Run service tests**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti/services/tuttid
go test ./service/agent -run 'TestServiceFork|TestServiceCreate|TestServiceSendInput' -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit service changes**

```bash
cd /Users/chovy/Desktop/workspace/tutti
git add services/tuttid/service/agent/session_types.go services/tuttid/service/agent/service_fork.go services/tuttid/service/agent/service_fork_test.go
git commit -m "feat(agent): add fork service orchestration"
```

## Task 4: tuttid API And Generated Clients

**Files:**

- Modify: `services/tuttid/api/openapi/tuttid.v1.yaml`
- Modify: `services/tuttid/api/daemon_agent_sessions.go`
- Create: `services/tuttid/api/daemon_agent_sessions_fork.go`
- Create: `services/tuttid/api/daemon_agent_sessions_fork_test.go`
- Generated: `services/tuttid/api/generated/types.gen.go`
- Generated: `packages/clients/tuttid-ts/src/generated/**`

- [ ] **Step 1: Write failing API test**

Add:

```go
func TestForkWorkspaceAgentSession(t *testing.T) {
	service := &fakeAgentSessionService{
		forkResult: agentservice.ForkSessionResult{
			Session: agentservice.Session{
				ID:                "child",
				Provider:          "codex",
				ProviderSessionID: "thread-child",
				Status:            "ready",
				Visible:           true,
			},
			Fork: agentservice.ForkLineage{
				SourceAgentSessionID:    "parent",
				TargetAgentSessionID:    "child",
				SourceProviderSessionID: "thread-parent",
				TargetProviderSessionID: "thread-child",
				Provider:                "codex",
				ForkedAtUnixMS:          1782892800000,
			},
		},
	}
	api := testDaemonAPI(t)
	api.AgentSessionService = service
	recorder := performGeneratedRouteRequest(t, api.Handler(), http.MethodPost,
		"/v1/workspaces/ws-1/agent-sessions/parent/fork",
		tuttigenerated.ForkWorkspaceAgentSessionRequest{RequestId: "request-1"},
	)
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
}
```

- [ ] **Step 2: Run API test and verify it fails**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti/services/tuttid
go test ./api -run TestForkWorkspaceAgentSession -count=1
```

Expected: FAIL because OpenAPI/generated handler does not exist.

- [ ] **Step 3: Update OpenAPI**

Add path:

```yaml
/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/fork:
  parameters:
    - $ref: "#/components/parameters/WorkspaceID"
    - $ref: "#/components/parameters/AgentSessionID"
  post:
    operationId: forkWorkspaceAgentSession
    tags:
      - agent-session
    summary: Fork one workspace agent session
    requestBody:
      required: true
      content:
        application/json:
          schema:
            $ref: "#/components/schemas/ForkWorkspaceAgentSessionRequest"
    responses:
      "201":
        description: Workspace agent session forked
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/WorkspaceAgentSessionForkResponse"
      "400":
        $ref: "#/components/responses/InvalidRequestError"
      "404":
        $ref: "#/components/responses/WorkspaceNotFoundError"
      "409":
        $ref: "#/components/responses/WorkspaceOperationError"
      "422":
        $ref: "#/components/responses/InvalidRequestError"
      "502":
        $ref: "#/components/responses/WorkspaceOperationError"
      "503":
        $ref: "#/components/responses/ServiceUnavailableError"
```

Add schemas:

```yaml
ForkWorkspaceAgentSessionRequest:
  type: object
  additionalProperties: false
  required:
    - requestId
  properties:
    requestId:
      type: string
      minLength: 1
    targetAgentSessionId:
      type: string
      format: uuid
      nullable: true
    lastTurnId:
      type: string
      nullable: true
    title:
      type: string
      nullable: true
    visible:
      type: boolean
      nullable: true
    settings:
      $ref: "#/components/schemas/AgentSessionComposerSettings"
WorkspaceAgentSessionFork:
  type: object
  additionalProperties: false
  required:
    - sourceAgentSessionId
    - targetAgentSessionId
    - sourceProviderSessionId
    - targetProviderSessionId
    - provider
    - forkedAtUnixMs
  properties:
    sourceAgentSessionId:
      type: string
    targetAgentSessionId:
      type: string
    sourceProviderSessionId:
      type: string
    targetProviderSessionId:
      type: string
    provider:
      $ref: "#/components/schemas/WorkspaceAgentProvider"
    lastTurnId:
      type: string
      nullable: true
    forkedAtUnixMs:
      type: integer
      format: int64
WorkspaceAgentSessionForkResponse:
  type: object
  additionalProperties: false
  required:
    - session
    - fork
  properties:
    session:
      $ref: "#/components/schemas/WorkspaceAgentSession"
    fork:
      $ref: "#/components/schemas/WorkspaceAgentSessionFork"
```

- [ ] **Step 4: Generate API code**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti
pnpm generate:api
```

Expected: generated Go and TS client files update without errors.

- [ ] **Step 5: Add API handler**

Extend `AgentSessionService` in `daemon_agent_sessions.go`:

```go
Fork(context.Context, string, string, agentservice.ForkSessionInput) (agentservice.ForkSessionResult, error)
```

Create `daemon_agent_sessions_fork.go`:

```go
func (api DaemonAPI) ForkWorkspaceAgentSession(ctx context.Context, request tuttigenerated.ForkWorkspaceAgentSessionRequestObject) (tuttigenerated.ForkWorkspaceAgentSessionResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ForkWorkspaceAgentSession503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	input := agentservice.ForkSessionInput{
		RequestID: strings.TrimSpace(request.Body.RequestId),
	}
	if request.Body.TargetAgentSessionId != nil {
		input.TargetAgentSessionID = request.Body.TargetAgentSessionId.String()
	}
	input.LastTurnID = optionalStringValue(request.Body.LastTurnId)
	input.Title = request.Body.Title
	input.Visible = request.Body.Visible
	if request.Body.Settings != nil {
		settings := composerSettingsPatchFromGenerated(*request.Body.Settings)
		input.Settings = &settings
	}
	result, err := api.AgentSessionService.Fork(ctx, string(request.WorkspaceID), string(request.AgentSessionID), input)
	if err != nil {
		return writeForkWorkspaceAgentSessionError(err), nil
	}
	return tuttigenerated.ForkWorkspaceAgentSession201JSONResponse{
		Session: generatedAgentSession(result.Session),
		Fork:    generatedAgentSessionFork(result.Fork),
	}, nil
}
```

- [ ] **Step 6: Run API and generated checks**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti
pnpm check:api-generated
cd services/tuttid
go test ./api -run 'TestForkWorkspaceAgentSession|TestWorkspaceAgentSession' -count=1
```

Expected: PASS.

- [ ] **Step 7: Commit API changes**

```bash
cd /Users/chovy/Desktop/workspace/tutti
git add services/tuttid/api/openapi/tuttid.v1.yaml services/tuttid/api/daemon_agent_sessions.go services/tuttid/api/daemon_agent_sessions_fork.go services/tuttid/api/daemon_agent_sessions_fork_test.go services/tuttid/api/generated packages/clients/tuttid-ts/src/generated
git commit -m "feat(agent): expose agent session fork api"
```

## Task 5: Desktop Activity Runtime

**Files:**

- Modify: `packages/agent/activity-core/src/types.ts`
- Modify: `packages/agent/activity-core/src/adapter.ts`
- Modify: `packages/clients/tuttid-ts/src/tuttidClient.ts`
- Modify: `packages/clients/tuttid-ts/src/tuttidClientTypes.ts`
- Modify: `packages/clients/tuttid-ts/src/index.test.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/services/workspaceAgentActivityService.interface.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts`
- Modify tests near those files.

- [ ] **Step 1: Write failing adapter/runtime tests**

Add tests asserting `forkSession` calls the tuttid client and returns child session:

```ts
test("desktop agent activity adapter forks sessions through tuttid", async () => {
  const tuttidClient = createFakeTuttidClient({
    async forkWorkspaceAgentSession(workspaceId, agentSessionId, body) {
      assert.equal(workspaceId, "ws-1");
      assert.equal(agentSessionId, "parent");
      assert.equal(body.requestId, "request-1");
      assert.equal(body.lastTurnId, "turn-1");
      return {
        fork: {
          forkedAtUnixMs: 1782892800000,
          provider: "codex",
          sourceAgentSessionId: "parent",
          sourceProviderSessionId: "thread-parent",
          targetAgentSessionId: "child",
          targetProviderSessionId: "thread-child"
        },
        session: createWorkspaceAgentSession({ id: "child", provider: "codex" })
      };
    }
  });
  const adapter = createDesktopAgentActivityAdapter({
    tuttidClient,
    runtimeApi: fakeRuntimeApi
  });
  const result = await adapter.forkSession({
    agentSessionId: "parent",
    lastTurnId: "turn-1",
    requestId: "request-1",
    workspaceId: "ws-1"
  });
  assert.equal(result.session.agentSessionId, "child");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti/apps/desktop
node --import ./test/register-asset-stub.mjs --test --experimental-strip-types "./src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.test.ts"
```

Expected: FAIL because fork contracts are missing.

- [ ] **Step 3: Add TypeScript contracts**

Add to `packages/agent/activity-core/src/types.ts`:

```ts
export interface AgentActivityForkSessionInput {
  agentSessionId: string;
  lastTurnId?: string | null;
  requestId: string;
  targetAgentSessionId?: string | null;
  title?: string | null;
  visible?: boolean | null;
  workspaceId: string;
}

export interface AgentActivityForkSessionLineage {
  forkedAtUnixMs: number;
  lastTurnId?: string | null;
  provider: string;
  sourceAgentSessionId: string;
  sourceProviderSessionId: string;
  targetAgentSessionId: string;
  targetProviderSessionId: string;
}

export interface AgentActivityForkSessionResult {
  fork: AgentActivityForkSessionLineage;
  session: AgentActivitySession;
}
```

Extend `AgentActivityAdapter` with `forkSession(input): Promise<AgentActivityForkSessionResult>`.

Add `forkWorkspaceAgentSession` to the handwritten tuttid client facade:

```ts
async forkWorkspaceAgentSession(workspaceID, agentSessionID, request, requestOptions) {
  const response = await forkWorkspaceAgentSession({
    body: request,
    client,
    path: { workspaceID, agentSessionID },
    signal: requestOptions?.signal
  });
  return unwrapTuttidResponse(response);
}
```

- [ ] **Step 4: Implement desktop adapter/service/runtime**

In `desktopAgentActivityAdapter.ts`:

```ts
async forkSession(input) {
  const response = await tuttidClient.forkWorkspaceAgentSession(
    input.workspaceId,
    input.agentSessionId,
    {
      lastTurnId: input.lastTurnId ?? null,
      requestId: input.requestId,
      targetAgentSessionId: input.targetAgentSessionId ?? null,
      title: input.title ?? null,
      visible: input.visible ?? null
    }
  );
  return {
    fork: response.fork,
    session: toAgentActivitySession(response.session)
  };
}
```

In `workspaceAgentActivityService.ts`, delegate to adapter, refresh the workspace snapshot, and return the result:

```ts
async forkSession(input) {
  const entry = this.entryForWorkspace(input.workspaceId);
  const result = await entry.adapter.forkSession(input);
  await this.load(input.workspaceId);
  return result;
}
```

In `createDesktopAgentActivityRuntime.ts`:

```ts
async forkSession(input) {
  return workspaceAgentActivityService.forkSession(input);
}
```

- [ ] **Step 5: Run desktop tests**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti/apps/desktop
node --import ./test/register-asset-stub.mjs --test --experimental-strip-types \
  "./src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.test.ts" \
  "./src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.test.ts"
cd /Users/chovy/Desktop/workspace/tutti
pnpm --filter @tutti-os/client-tuttid-ts test -- index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit desktop runtime changes**

```bash
cd /Users/chovy/Desktop/workspace/tutti
git add packages/agent/activity-core/src/types.ts packages/agent/activity-core/src/adapter.ts packages/clients/tuttid-ts/src/tuttidClient.ts packages/clients/tuttid-ts/src/tuttidClientTypes.ts packages/clients/tuttid-ts/src/index.test.ts apps/desktop/src/renderer/src/features/workspace-agent/services
git commit -m "feat(agent): wire fork through desktop activity runtime"
```

## Task 6: Agent GUI Fork Actions

**Files:**

- Modify: `packages/agent/gui/agentActivityRuntime.tsx`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/controller/agentGuiController.types.ts`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/AgentSessionChrome.tsx`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/agentGuiNodeViewConversation.tsx`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/AgentSessionChrome.spec.tsx`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/agentGuiNodeViewConversation.spec.ts`

- [ ] **Step 1: Write failing GUI controller tests**

Add test:

```tsx
it("forks the active conversation and selects the returned child", async () => {
  const runtime = createAgentActivityRuntimeForControllerTest({
    async forkSession(input) {
      expect(input.agentSessionId).toBe("parent");
      return {
        fork: {
          forkedAtUnixMs: 1782892800000,
          provider: "codex",
          sourceAgentSessionId: "parent",
          sourceProviderSessionId: "thread-parent",
          targetAgentSessionId: "child",
          targetProviderSessionId: "thread-child"
        },
        session: createActivitySession({
          agentSessionId: "child",
          provider: "codex"
        })
      };
    }
  });
  const harness = renderAgentGuiController({
    runtime,
    activeSessionId: "parent"
  });
  await act(async () => {
    await harness.actions.forkActiveConversation();
  });
  expect(harness.selectedAgentSessionId()).toBe("child");
});
```

- [ ] **Step 2: Run GUI tests and verify failure**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti
pnpm --filter @tutti-os/agent-gui test -- useAgentGUINodeController
```

Expected: FAIL because actions are missing.

- [ ] **Step 3: Extend AgentActivityRuntime interface**

Add to `agentActivityRuntime.tsx`:

```ts
forkSession(
  input: AgentActivityForkSessionInput
): Promise<AgentActivityForkSessionResult>;
```

- [ ] **Step 4: Add controller actions**

Add actions:

```ts
const forkActiveConversation = useCallback(async () => {
  const session = activeConversationSession;
  if (!session) return;
  const result = await agentActivityRuntime.forkSession({
    agentSessionId: session.agentSessionId,
    requestId: crypto.randomUUID(),
    workspaceId
  });
  await agentActivityRuntime.load(workspaceId);
  selectConversation(result.session.agentSessionId);
}, [
  activeConversationSession,
  agentActivityRuntime,
  selectConversation,
  workspaceId
]);

const forkConversationFromTurn = useCallback(
  async (turnId: string) => {
    const session = activeConversationSession;
    const normalizedTurnId = turnId.trim();
    if (!session || !normalizedTurnId) return;
    const result = await agentActivityRuntime.forkSession({
      agentSessionId: session.agentSessionId,
      lastTurnId: normalizedTurnId,
      requestId: crypto.randomUUID(),
      workspaceId
    });
    await agentActivityRuntime.load(workspaceId);
    selectConversation(result.session.agentSessionId);
  },
  [
    activeConversationSession,
    agentActivityRuntime,
    selectConversation,
    workspaceId
  ]
);
```

Expose them in `viewModel.actions`.

- [ ] **Step 5: Add UI entry points**

In `AgentSessionChrome.tsx`, add a menu item:

```tsx
<button type="button" onClick={actions.forkActiveConversation}>
  Fork conversation
</button>
```

Render parent indicator when runtime context contains `forkParentTitle`:

```tsx
{
  forkParentTitle ? (
    <button type="button" onClick={actions.openForkParent}>
      Forked from {forkParentTitle}
    </button>
  ) : null;
}
```

In `agentGuiNodeViewConversation.tsx`, add `Fork from here` to completed turn actions and pass `turnId`.

- [ ] **Step 6: Run Agent GUI tests**

Run:

```bash
cd /Users/chovy/Desktop/workspace/tutti
pnpm --filter @tutti-os/agent-gui test -- 'useAgentGUINodeController|AgentSessionChrome|agentGuiNodeViewConversation'
```

Expected: PASS.

- [ ] **Step 7: Commit GUI changes**

```bash
cd /Users/chovy/Desktop/workspace/tutti
git add packages/agent/gui
git commit -m "feat(agent-gui): add agent session fork actions"
```

## Task 7: End-To-End Validation

**Files:**

- No new source files unless earlier tasks reveal missing generated code.

- [ ] **Step 1: Run generated API check**

```bash
cd /Users/chovy/Desktop/workspace/tutti
pnpm check:api-generated
```

Expected: PASS.

- [ ] **Step 2: Run focused Go tests**

```bash
cd /Users/chovy/Desktop/workspace/tutti/services/tuttid
go test ./data/workspace ./service/agent ./api -run 'Fork|AgentSession' -count=1
cd /Users/chovy/Desktop/workspace/tutti/packages/agent/daemon
go test ./runtime -run 'Fork|CodexAppServer|Controller' -count=1
```

Expected: PASS.

- [ ] **Step 3: Run focused TypeScript tests**

```bash
cd /Users/chovy/Desktop/workspace/tutti
cd apps/desktop
node --import ./test/register-asset-stub.mjs --test --experimental-strip-types \
  "./src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.test.ts" \
  "./src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.test.ts"
cd ../..
pnpm --filter @tutti-os/client-tuttid-ts test -- index.test.ts
pnpm --filter @tutti-os/agent-gui test -- 'useAgentGUINodeController|AgentSessionChrome|agentGuiNodeViewConversation'
```

Expected: PASS.

- [ ] **Step 4: Run broad changed-surface checks**

```bash
cd /Users/chovy/Desktop/workspace/tutti
pnpm check:api-generated
pnpm --filter @tutti-os/agent-gui test
pnpm --filter @tutti-os/desktop test -- workspace-agent
cd services/tuttid && go test ./service/agent ./api ./data/workspace
cd ../../packages/agent/daemon && go test ./runtime
```

Expected: PASS.

- [ ] **Step 5: Commit validation fixes if needed**

If any validation-only fixes were required, inspect the changed files, stage only files that belong to this fork feature, then commit:

```bash
cd /Users/chovy/Desktop/workspace/tutti
git status --short
```

After staging the fork-feature validation fixes, run:

```bash
cd /Users/chovy/Desktop/workspace/tutti
git commit -m "test(agent): cover agent session fork"
```

If no fixes were required, do not create an empty commit.

## Self-Review Checklist

- [ ] Storage implements the dedicated lineage table from the design.
- [ ] Runtime fork calls Codex `thread/fork`; it does not clone UI messages as the source of truth.
- [ ] Service creates child session title with `<parent title>(fork<num>)`.
- [ ] Service preserves idempotency by `requestId`.
- [ ] API exposes a typed fork endpoint and generated clients are current.
- [ ] Desktop runtime exposes `forkSession`.
- [ ] Agent GUI has full-conversation and from-turn fork actions.
- [ ] Running/in-progress turn fork is disabled or rejected.
- [ ] Tests cover runtime, service, storage, API, desktop adapter, and GUI.
