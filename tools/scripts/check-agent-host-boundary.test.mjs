import assert from "node:assert/strict";
import test from "node:test";
import {
  findBoundaryViolations,
  findProductionCompositionViolations,
  findStaleAllowlistEntries,
  isAllowlisted,
  isTestSource
} from "./check-agent-host-boundary.mjs";

test("requires production wiring to consume shared Host adapters", () => {
  const source = [
    "agenthostadapter.RuntimeController{}",
    "agenthost.SQLiteWorkspaceStore{}",
    "agentservice.NewApplicationHostWithPorts(service, store, runtime)"
  ].join("\n");
  assert.deepEqual(findProductionCompositionViolations(source), []);
  assert.equal(findProductionCompositionViolations("legacy wiring").length, 3);
});

test("rejects service-local Host store/runtime composition in production", () => {
  const source = [
    "type serviceHostStore struct {}",
    "type serviceHostRuntime struct {}",
    "func NewApplicationHost() {}"
  ].join("\n");
  assert.equal(
    findBoundaryViolations(
      "services/tuttid/service/agent/host_adapters.go",
      source
    ).length,
    3
  );
});

test("flags a new *Coordinator production type declaration", () => {
  const source = [
    "package agent",
    "",
    "type sessionLifecycleCoordinator struct {",
    "\tstore CanonicalStore",
    "}"
  ].join("\n");
  assert.deepEqual(
    findBoundaryViolations(
      "services/tuttid/service/agent/session_lifecycle.go",
      source
    ),
    [
      "services/tuttid/service/agent/session_lifecycle.go:3: type sessionLifecycleCoordinator struct {"
    ]
  );
});

test("flags new *Worker and *Actor type declarations, struct and interface", () => {
  const source = [
    "type turnResumeWorker struct {}",
    "type GoalRevisionActor interface {}"
  ].join("\n");
  assert.equal(
    findBoundaryViolations(
      "services/tuttid/service/agent/turn_orchestration.go",
      source
    ).length,
    2
  );
});

test("flags orchestration type declarations inside a grouped type block", () => {
  const source = [
    "package agent",
    "",
    "type (",
    "\tsessionRef struct {",
    "\t\tid string",
    "\t}",
    "\tturnResumeCoordinator struct {",
    "\t\tstore CanonicalStore",
    "\t}",
    "\tgoalSagaWorker interface {",
    "\t\tRun(ctx context.Context) error",
    "\t}",
    ")"
  ].join("\n");
  assert.deepEqual(
    findBoundaryViolations(
      "services/tuttid/service/agent/turn_orchestration.go",
      source
    ),
    [
      "services/tuttid/service/agent/turn_orchestration.go:7: turnResumeCoordinator struct {",
      "services/tuttid/service/agent/turn_orchestration.go:10: goalSagaWorker interface {"
    ]
  );
});

test("allows non-orchestration types inside a grouped type block", () => {
  const source = [
    "package agent",
    "",
    "type (",
    "\tsessionFilter struct {",
    "\t\tworkerPool string",
    "\t}",
    "\tcoordinatorHandle struct {",
    "\t\tref string",
    "\t}",
    "\tmodelCatalog interface {",
    "\t\tList(ctx context.Context) ([]string, error)",
    "\t}",
    ")",
    "",
    "func afterGroup() {",
    "\t// a later brace-heavy body must not leak group state",
    "}"
  ].join("\n");
  assert.deepEqual(
    findBoundaryViolations(
      "services/tuttid/service/agent/composer_options.go",
      source
    ),
    []
  );
});

test("flags a new orchestration-named production file by filename", () => {
  const violations = findBoundaryViolations(
    "services/tuttid/service/agent/turn_send_worker.go",
    "package agent\n"
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /filename declares an agent application-core/u);
});

test("allows adapter code that does not orchestrate lifecycle", () => {
  const source = [
    "package agent",
    "",
    "func (s *Service) getSession(ctx context.Context, id string) error {",
    "\treturn s.ApplicationHost().GetSession(ctx, id)",
    "}"
  ].join("\n");
  assert.deepEqual(
    findBoundaryViolations(
      "services/tuttid/service/agent/service_session.go",
      source
    ),
    []
  );
});

test("does not treat non-suffix names as orchestration types", () => {
  const source = [
    "type coordinatorHandle struct {}",
    "type workerPoolConfig struct {}",
    "type actorGreeting struct {}"
  ].join("\n");
  assert.deepEqual(
    findBoundaryViolations(
      "services/tuttid/service/agent/composer_options.go",
      source
    ),
    []
  );
});

test("skips test sources", () => {
  const source = "type goalReconcileInboxWorkerStore struct {}";
  assert.deepEqual(
    findBoundaryViolations(
      "services/tuttid/service/agent/goal_reconcile_inbox_worker_test.go",
      source
    ),
    []
  );
});

test("exempts allowlisted existing files including their filename", () => {
  assert.equal(
    isAllowlisted(
      "services/tuttid/service/agent/composer_live_model_coordinator.go"
    ),
    true
  );
  assert.deepEqual(
    findBoundaryViolations(
      "services/tuttid/service/agent/composer_live_model_coordinator.go",
      "type liveModelDiscoveryCoordinator struct {}"
    ),
    []
  );
  assert.equal(
    isAllowlisted("services/tuttid/service/agent/new_send_coordinator.go"),
    false
  );
});

test("identifies test sources", () => {
  assert.equal(isTestSource("service/agent/service_test.go"), true);
  assert.equal(isTestSource("service/agent/service.go"), false);
});

test("reports allowlist entries whose files no longer exist", () => {
  assert.deepEqual(
    findStaleAllowlistEntries(() => true),
    []
  );
  const stale = findStaleAllowlistEntries(() => false);
  assert.ok(stale.length >= 1);
  assert.ok(
    stale.includes(
      "services/tuttid/service/agent/composer_live_model_coordinator.go"
    )
  );
});
