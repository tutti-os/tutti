package agenthost

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type batchRuntime struct {
	RuntimeController
	live       map[string]bool
	closeOrder []string
	events     *[]string
}

func (r *batchRuntime) Session(_, sessionID string) (ProviderRuntimeSession, bool) {
	return ProviderRuntimeSession{ID: sessionID}, r.live[sessionID]
}

func (r *batchRuntime) Close(_ context.Context, input RuntimeCloseInput) error {
	r.closeOrder = append(r.closeOrder, input.AgentSessionID)
	if r.events != nil {
		*r.events = append(*r.events, "close:"+input.AgentSessionID)
	}
	delete(r.live, input.AgentSessionID)
	return nil
}

type batchManagementStore struct {
	runtime              *batchRuntime
	plan                 []string
	input                storesqlite.DeleteSessionsBatchInput
	changes              int
	calls                int
	useExactPlan         bool
	clearPlanAfterDelete bool
	plans                [][]string
	planCalls            int
	events               *[]string
}

type batchCleanup struct {
	failedSessionID string
	calls           []string
	inputs          []RuntimeCleanupInput
}

func (s *batchManagementStore) PlanClearSessions(_ context.Context, workspaceID string) (storesqlite.DeleteSessionsPlan, error) {
	return storesqlite.DeleteSessionsPlan{WorkspaceID: workspaceID, SessionIDs: append([]string(nil), s.plan...)}, nil
}

func (*batchCleanup) Prepare(context.Context, RuntimePreparationInput) (PreparedRuntime, error) {
	return PreparedRuntime{}, nil
}

func (c *batchCleanup) Cleanup(_ context.Context, input RuntimeCleanupInput) error {
	c.calls = append(c.calls, input.AgentSessionID)
	c.inputs = append(c.inputs, input)
	if input.AgentSessionID == c.failedSessionID {
		return errors.New("cleanup failed")
	}
	return nil
}

func (s *batchManagementStore) PlanDeleteSessions(_ context.Context, input storesqlite.DeleteSessionsBatchInput) (storesqlite.DeleteSessionsPlan, error) {
	plan := s.plan
	if len(s.plans) > 0 {
		index := s.planCalls
		if index >= len(s.plans) {
			index = len(s.plans) - 1
		}
		plan = s.plans[index]
		s.planCalls++
	}
	if len(plan) == 0 && !s.useExactPlan {
		plan = input.SessionIDs
	}
	return storesqlite.DeleteSessionsPlan{WorkspaceID: input.WorkspaceID, SessionIDs: append([]string(nil), plan...)}, nil
}

func TestDeleteSessionClosesLiveRuntimeBeforeFirstCanonicalReport(t *testing.T) {
	runtime := &batchRuntime{live: map[string]bool{"session-live-only": true}}
	store := &batchManagementStore{runtime: runtime, useExactPlan: true}
	host := New(Config{Runtime: runtime, SessionBatchManagement: store})

	result, err := host.DeleteSession(t.Context(), SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-live-only",
	})
	if err != nil {
		t.Fatalf("DeleteSession() error = %v", err)
	}
	if !result.Deleted || !result.RuntimeClosed || result.CanonicalRemoved {
		t.Fatalf("DeleteSession() result = %#v", result)
	}
	if !reflect.DeepEqual(runtime.closeOrder, []string{"session-live-only"}) {
		t.Fatalf("runtime close order = %#v", runtime.closeOrder)
	}
	if store.calls != 0 {
		t.Fatalf("canonical delete calls = %d, want none without a canonical row", store.calls)
	}
}

func (s *batchManagementStore) DeleteSessionsBatch(_ context.Context, input storesqlite.DeleteSessionsBatchInput) (storesqlite.DeleteSessionsBatchResult, error) {
	s.calls++
	if s.events != nil {
		*s.events = append(*s.events, "delete:"+strings.Join(input.ExpectedSessionIDs, ","))
	}
	if s.changes > 0 {
		s.changes--
		return storesqlite.DeleteSessionsBatchResult{}, storesqlite.ErrDeleteSessionsPlanChanged
	}
	if len(s.runtime.live) != 0 {
		panic("canonical batch delete ran before all live runtimes closed")
	}
	s.input = input
	if s.clearPlanAfterDelete {
		s.plan = nil
	}
	return storesqlite.DeleteSessionsBatchResult{
		RemovedSessionIDs: append([]string(nil), input.SessionIDs...),
		RemovedSessions:   len(input.SessionIDs),
		RemovedMessages:   3,
	}, nil
}

type batchDeletionGuard struct {
	admissionErr error
	plans        []DeleteSessionsPlan
	reports      []DeleteSessionsReport
	events       *[]string
}

func (g *batchDeletionGuard) AdmitDeleteSessions(_ context.Context, plan DeleteSessionsPlan) error {
	g.plans = append(g.plans, plan)
	if g.events != nil {
		*g.events = append(*g.events, "admit:"+strings.Join(plan.SessionIDs, ","))
	}
	return g.admissionErr
}

func (g *batchDeletionGuard) ReportDeleteSessions(_ context.Context, report DeleteSessionsReport) {
	g.reports = append(g.reports, report)
	if g.events != nil {
		status := "success"
		if report.Err != nil {
			status = "failure"
		}
		*g.events = append(*g.events, "report-"+status+":"+strings.Join(report.Plan.SessionIDs, ","))
	}
}

func TestDeleteSessionsAdmissionRejectsBeforeCanonicalSideEffects(t *testing.T) {
	rejected := errors.New("delete admission rejected")
	runtime := &batchRuntime{live: map[string]bool{"child": true, "root": true}}
	store := &batchManagementStore{runtime: runtime, plan: []string{"child", "root"}}
	guard := &batchDeletionGuard{admissionErr: rejected}
	host := New(Config{Runtime: runtime, SessionBatchManagement: store, SessionDeletionGuard: guard})

	_, err := host.DeleteSessions(t.Context(), DeleteSessionsInput{
		WorkspaceID: "workspace-1", SessionIDs: []string{"root"},
	})
	if !errors.Is(err, rejected) {
		t.Fatalf("DeleteSessions() error = %v, want admission rejection", err)
	}
	wantPlan := DeleteSessionsPlan{WorkspaceID: "workspace-1", SessionIDs: []string{"child", "root"}}
	if !reflect.DeepEqual(guard.plans, []DeleteSessionsPlan{wantPlan}) {
		t.Fatalf("admission plans = %#v, want %#v", guard.plans, []DeleteSessionsPlan{wantPlan})
	}
	if len(runtime.closeOrder) != 0 || store.calls != 0 || len(guard.reports) != 0 {
		t.Fatalf("rejected deletion side effects: closes=%#v deletes=%d reports=%#v", runtime.closeOrder, store.calls, guard.reports)
	}
}

func TestDeleteSessionsReadmitsChangedClosureBeforeAdditionalRuntimeClose(t *testing.T) {
	events := make([]string, 0)
	runtime := &batchRuntime{live: map[string]bool{"child": true, "root": true}, events: &events}
	store := &batchManagementStore{
		runtime: runtime, plans: [][]string{{"root"}, {"child", "root"}}, changes: 1, events: &events,
	}
	guard := &batchDeletionGuard{events: &events}
	host := New(Config{Runtime: runtime, SessionBatchManagement: store, SessionDeletionGuard: guard})

	result, err := host.DeleteSessions(t.Context(), DeleteSessionsInput{
		WorkspaceID: "workspace-1", SessionIDs: []string{"root"},
	})
	if err != nil {
		t.Fatalf("DeleteSessions() error = %v", err)
	}
	wantEvents := []string{
		"admit:root",
		"close:root",
		"delete:root",
		"report-failure:root",
		"admit:child,root",
		"close:child",
		"delete:child,root",
		"report-success:child,root",
	}
	if !reflect.DeepEqual(events, wantEvents) {
		t.Fatalf("deletion events = %#v, want %#v", events, wantEvents)
	}
	if !reflect.DeepEqual(result.RuntimeClosedIDs, []string{"child", "root"}) {
		t.Fatalf("runtime closed ids = %#v", result.RuntimeClosedIDs)
	}
}

func TestConditionalDeleteReplansUnderLockBeforeClosingRuntime(t *testing.T) {
	runtime := &batchRuntime{live: map[string]bool{"root": true}}
	store := &batchManagementStore{
		runtime: runtime, plans: [][]string{{"root"}, {}, {}}, useExactPlan: true,
	}
	host := New(Config{Runtime: runtime, SessionBatchManagement: store})

	result, err := host.DeleteSessions(t.Context(), DeleteSessionsInput{
		WorkspaceID:                "workspace-1",
		SessionIDs:                 []string{"root"},
		RequiredRootRailSectionKey: "project:/workspace/project",
		ExcludePinnedRoots:         true,
	})
	if err != nil {
		t.Fatalf("DeleteSessions() error = %v", err)
	}
	if len(runtime.closeOrder) != 0 || store.calls != 0 || len(result.RemovedSessionIDs) != 0 {
		t.Fatalf("conditional deletion side effects: closes=%#v deletes=%d result=%#v", runtime.closeOrder, store.calls, result)
	}
	if !runtime.live["root"] {
		t.Fatal("runtime was closed after root stopped satisfying deletion conditions")
	}
}

func TestDeleteSessionIsIdempotentWhenCanonicalSessionIsAlreadyGone(t *testing.T) {
	runtime := &batchRuntime{live: map[string]bool{}}
	store := &batchManagementStore{
		runtime:              runtime,
		plan:                 []string{"session-replay"},
		useExactPlan:         true,
		clearPlanAfterDelete: true,
	}
	host := New(Config{Runtime: runtime, SessionBatchManagement: store})
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-replay"}

	first, err := host.DeleteSession(t.Context(), ref)
	if err != nil {
		t.Fatalf("first DeleteSession() error = %v", err)
	}
	if !first.Deleted || !first.CanonicalRemoved {
		t.Fatalf("first DeleteSession() result = %#v", first)
	}

	second, err := host.DeleteSession(t.Context(), ref)
	if err != nil {
		t.Fatalf("replayed DeleteSession() error = %v", err)
	}
	if second.Deleted || second.RuntimeClosed || second.CanonicalRemoved || second.CleanupFailed {
		t.Fatalf("replayed DeleteSession() result = %#v, want a successful no-op", second)
	}
	if store.calls != 1 {
		t.Fatalf("canonical delete calls = %d, want one committed delete", store.calls)
	}

	batch, err := host.DeleteSessions(t.Context(), DeleteSessionsInput{
		WorkspaceID: "workspace-1", SessionIDs: []string{"session-replay"},
	})
	if err != nil {
		t.Fatalf("replayed DeleteSessions() error = %v", err)
	}
	if batch.RemovedSessionIDs == nil || batch.RuntimeClosedIDs == nil || batch.CleanupFailedIDs == nil {
		t.Fatalf("replayed DeleteSessions() result = %#v, want non-nil empty arrays", batch)
	}
}

func TestDeleteSessionsUsesOneCanonicalBatchAfterClosingRuntimes(t *testing.T) {
	runtime := &batchRuntime{live: map[string]bool{"session-a": true, "session-b": true}}
	store := &batchManagementStore{runtime: runtime}
	host := New(Config{Runtime: runtime, SessionBatchManagement: store})

	result, err := host.DeleteSessions(t.Context(), DeleteSessionsInput{
		WorkspaceID: " workspace-1 ",
		SessionIDs:  []string{"session-b", "session-a", "session-b", " "},
	})
	if err != nil {
		t.Fatalf("DeleteSessions() error = %v", err)
	}
	wantIDs := []string{"session-a", "session-b"}
	if !reflect.DeepEqual(runtime.closeOrder, wantIDs) {
		t.Fatalf("runtime close order = %#v, want %#v", runtime.closeOrder, wantIDs)
	}
	if store.input.WorkspaceID != "workspace-1" || !reflect.DeepEqual(store.input.SessionIDs, wantIDs) || !reflect.DeepEqual(store.input.ExpectedSessionIDs, wantIDs) {
		t.Fatalf("canonical batch input = %#v", store.input)
	}
	if result.RemovedSessions != 2 || result.RemovedMessages != 3 || !reflect.DeepEqual(result.RemovedSessionIDs, wantIDs) || !reflect.DeepEqual(result.RuntimeClosedIDs, wantIDs) {
		t.Fatalf("DeleteSessions() result = %#v", result)
	}
}

func TestClearSessionsUsesCanonicalPlanAndSharedDeletionCoordinator(t *testing.T) {
	runtime := &batchRuntime{live: map[string]bool{"session-a": true, "session-b": true}}
	store := &batchManagementStore{runtime: runtime, plan: []string{"session-a", "session-b"}}
	host := New(Config{Runtime: runtime, SessionBatchManagement: store})

	result, err := host.ClearSessions(t.Context(), " workspace-1 ")
	if err != nil {
		t.Fatalf("ClearSessions() error = %v", err)
	}
	if !reflect.DeepEqual(result.RemovedSessionIDs, []string{"session-a", "session-b"}) {
		t.Fatalf("ClearSessions() result = %#v", result)
	}
	if !reflect.DeepEqual(runtime.closeOrder, []string{"session-a", "session-b"}) || store.calls != 1 {
		t.Fatalf("clear coordinator closeOrder=%#v calls=%d", runtime.closeOrder, store.calls)
	}
}

func TestDeleteSessionsClosesLiveChildFromCanonicalDeletionPlan(t *testing.T) {
	runtime := &batchRuntime{live: map[string]bool{"child": true}}
	store := &batchManagementStore{runtime: runtime, plan: []string{"child", "root"}}
	host := New(Config{Runtime: runtime, SessionBatchManagement: store})

	result, err := host.DeleteSessions(t.Context(), DeleteSessionsInput{
		WorkspaceID: "workspace-1",
		SessionIDs:  []string{"root"},
	})
	if err != nil {
		t.Fatalf("DeleteSessions() error = %v", err)
	}
	if !reflect.DeepEqual(runtime.closeOrder, []string{"child"}) {
		t.Fatalf("runtime close order = %#v", runtime.closeOrder)
	}
	if !reflect.DeepEqual(store.input.ExpectedSessionIDs, []string{"child", "root"}) {
		t.Fatalf("expected canonical closure = %#v", store.input.ExpectedSessionIDs)
	}
	if !reflect.DeepEqual(result.RuntimeClosedIDs, []string{"child"}) {
		t.Fatalf("runtime closed ids = %#v", result.RuntimeClosedIDs)
	}
}

func TestDeleteSessionsReportsPostCommitCleanupFailuresWithoutSkippingOtherSessions(t *testing.T) {
	runtime := &batchRuntime{live: map[string]bool{}}
	store := &batchManagementStore{runtime: runtime}
	cleanup := &batchCleanup{failedSessionID: "session-a"}
	host := New(Config{Runtime: runtime, SessionBatchManagement: store, RuntimePreparation: cleanup})

	result, err := host.DeleteSessions(t.Context(), DeleteSessionsInput{
		WorkspaceID: "workspace-1",
		SessionIDs:  []string{"session-a", "session-b"},
	})
	if err != nil {
		t.Fatalf("DeleteSessions() error = %v", err)
	}
	if !reflect.DeepEqual(cleanup.calls, []string{"session-a", "session-b"}) {
		t.Fatalf("cleanup calls = %#v", cleanup.calls)
	}
	for _, input := range cleanup.inputs {
		if !input.PreserveRecoverableState || input.OrphanActivationCleanup {
			t.Fatalf("soft-delete cleanup input = %#v, want recoverable state preserved", input)
		}
	}
	if !reflect.DeepEqual(result.CleanupFailedIDs, []string{"session-a"}) {
		t.Fatalf("cleanup failed ids = %#v", result.CleanupFailedIDs)
	}
}

func TestDeleteSessionsReplansWhenChildClosureChangesBeforeCommit(t *testing.T) {
	runtime := &batchRuntime{live: map[string]bool{"root": true}}
	store := &batchManagementStore{runtime: runtime, plan: []string{"root"}, changes: 1}
	host := New(Config{Runtime: runtime, SessionBatchManagement: store})

	result, err := host.DeleteSessions(t.Context(), DeleteSessionsInput{
		WorkspaceID: "workspace-1",
		SessionIDs:  []string{"root"},
	})
	if err != nil {
		t.Fatalf("DeleteSessions() error = %v", err)
	}
	if store.calls != 2 {
		t.Fatalf("canonical delete calls = %d, want replan then commit", store.calls)
	}
	if !reflect.DeepEqual(result.RuntimeClosedIDs, []string{"root"}) {
		t.Fatalf("runtime closed ids = %#v", result.RuntimeClosedIDs)
	}
}

func TestDeleteSessionsWaitsForSharedSessionMutationActor(t *testing.T) {
	runtime := &batchRuntime{live: map[string]bool{"root": true}}
	store := &batchManagementStore{runtime: runtime, plan: []string{"root"}}
	actor := NewSessionActor()
	host := New(Config{Runtime: runtime, SessionBatchManagement: store, SessionMutationActor: actor})
	held := make(chan struct{})
	release := make(chan struct{})
	go func() {
		_ = actor.Do(t.Context(), SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "root"}, func(context.Context) error {
			close(held)
			<-release
			return nil
		})
	}()
	<-held
	done := make(chan error, 1)
	go func() {
		_, err := host.DeleteSessions(t.Context(), DeleteSessionsInput{WorkspaceID: "workspace-1", SessionIDs: []string{"root"}})
		done <- err
	}()
	if len(runtime.closeOrder) != 0 {
		t.Fatalf("runtime closed before mutation actor released: %#v", runtime.closeOrder)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatalf("DeleteSessions() error = %v", err)
	}
	if !reflect.DeepEqual(runtime.closeOrder, []string{"root"}) {
		t.Fatalf("runtime close order = %#v", runtime.closeOrder)
	}
}

func TestDeleteSessionsFailsClosedWithoutBatchStore(t *testing.T) {
	host := New(Config{Runtime: &batchRuntime{live: map[string]bool{}}})
	if _, err := host.DeleteSessions(t.Context(), DeleteSessionsInput{WorkspaceID: "workspace-1", SessionIDs: []string{"session-1"}}); err == nil {
		t.Fatal("DeleteSessions succeeded without atomic batch storage")
	}
}
