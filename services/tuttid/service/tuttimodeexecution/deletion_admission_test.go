package tuttimodeexecution

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func TestSourceDeletionGuardRejectsWholeExactClosureAndReportsTerminalAttempt(t *testing.T) {
	t.Parallel()
	now := time.UnixMilli(1_700_002_000_000).UTC()
	wantErr := &executionbiz.ProtectedSourceError{
		WorkspaceID: "workspace-1",
		Issues: []executionbiz.ProtectedIssue{{
			IssueID: "issue-1", ExecutionID: "execution-1",
			SourceSessionID: "source-1", Status: executionbiz.StatusRunning,
		}},
	}
	store := &recordingDeletionAdmissionStore{admitErr: wantErr}
	guard := SourceDeletionGuard{Store: store, Clock: func() time.Time { return now }}
	plan := agenthost.DeleteSessionsPlan{
		WorkspaceID: "workspace-1", SessionIDs: []string{"child-1", "source-1"},
	}
	err := guard.AdmitDeleteSessions(context.Background(), plan)
	var protected *executionbiz.ProtectedSourceError
	if !errors.As(err, &protected) || len(store.admitted.SessionIDs) != 2 {
		t.Fatalf("AdmitDeleteSessions() error=%#v input=%#v", err, store.admitted)
	}
	if store.reported {
		t.Fatal("rejected admission was reported as an admitted attempt")
	}

	store.admitErr = nil
	if err := guard.AdmitDeleteSessions(context.Background(), plan); err != nil {
		t.Fatalf("AdmitDeleteSessions(admitted) error=%v", err)
	}
	guard.ReportDeleteSessions(context.Background(), agenthost.DeleteSessionsReport{
		Plan: plan, Err: errors.New("canonical closure changed"),
	})
	if !store.reported || store.succeeded {
		t.Fatalf("failed report state reported=%v succeeded=%v", store.reported, store.succeeded)
	}
}

func TestSourceDeletionGuardAllowsEmptyCanonicalClosureWithoutStoreMutation(t *testing.T) {
	t.Parallel()
	store := &recordingDeletionAdmissionStore{}
	guard := SourceDeletionGuard{Store: store}
	plan := agenthost.DeleteSessionsPlan{WorkspaceID: "workspace-1"}

	if err := guard.AdmitDeleteSessions(context.Background(), plan); err != nil {
		t.Fatalf("AdmitDeleteSessions() error=%v", err)
	}
	guard.ReportDeleteSessions(context.Background(), agenthost.DeleteSessionsReport{Plan: plan})

	if store.admitted.WorkspaceID != "" || store.reported {
		t.Fatalf("empty closure mutated store: admitted=%#v reported=%v", store.admitted, store.reported)
	}
}

func TestSourceDeletionGuardSerializesDuplicateExactClosuresUntilReport(t *testing.T) {
	t.Parallel()
	store := &concurrentDeletionAdmissionStore{admitCalls: make(chan struct{}, 2)}
	guard := &SourceDeletionGuard{Store: store}
	plan := agenthost.DeleteSessionsPlan{
		WorkspaceID: "workspace-1",
		SessionIDs:  []string{"source-1", "child-1"},
	}

	if err := guard.AdmitDeleteSessions(context.Background(), plan); err != nil {
		t.Fatalf("first AdmitDeleteSessions() error=%v", err)
	}
	<-store.admitCalls

	started := make(chan struct{})
	admitted := make(chan error, 1)
	go func() {
		close(started)
		admitted <- guard.AdmitDeleteSessions(context.Background(), plan)
	}()
	<-started
	select {
	case <-store.admitCalls:
		t.Fatal("duplicate closure reached the durable store before the first report")
	case <-time.After(25 * time.Millisecond):
	}

	guard.ReportDeleteSessions(context.Background(), agenthost.DeleteSessionsReport{Plan: plan})
	select {
	case err := <-admitted:
		if err != nil {
			t.Fatalf("second AdmitDeleteSessions() error=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("duplicate closure remained blocked after the first report")
	}
	<-store.admitCalls
	guard.ReportDeleteSessions(context.Background(), agenthost.DeleteSessionsReport{Plan: plan})
}

func TestSourceDeletionGuardReportsWithDetachedContext(t *testing.T) {
	t.Parallel()
	store := &recordingDeletionAdmissionStore{}
	guard := &SourceDeletionGuard{Store: store}
	plan := agenthost.DeleteSessionsPlan{
		WorkspaceID: "workspace-1",
		SessionIDs:  []string{"source-1"},
	}
	if err := guard.AdmitDeleteSessions(context.Background(), plan); err != nil {
		t.Fatalf("AdmitDeleteSessions() error=%v", err)
	}
	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()

	guard.ReportDeleteSessions(canceledCtx, agenthost.DeleteSessionsReport{Plan: plan})

	if !store.reported {
		t.Fatal("ReportDeleteSessions() did not reach the durable store")
	}
	if store.reportContextErr != nil {
		t.Fatalf("ReportDeleteSessions() context error=%v, want detached context", store.reportContextErr)
	}
}

func TestSourceDeletionGuardRetriesExactFailedReportBeforeReleasingClosure(t *testing.T) {
	t.Parallel()
	store := &retryingDeletionAdmissionStore{
		admitCalls:     make(chan struct{}, 2),
		reportCalls:    make(chan bool, 3),
		reportFailures: 1,
	}
	guard := &SourceDeletionGuard{Store: store}
	plan := agenthost.DeleteSessionsPlan{
		WorkspaceID: "workspace-1",
		SessionIDs:  []string{"source-1"},
	}
	if err := guard.AdmitDeleteSessions(context.Background(), plan); err != nil {
		t.Fatalf("first AdmitDeleteSessions() error=%v", err)
	}
	<-store.admitCalls

	guard.ReportDeleteSessions(context.Background(), agenthost.DeleteSessionsReport{Plan: plan})
	if succeeded := <-store.reportCalls; !succeeded {
		t.Fatal("failed report lost its exact successful outcome")
	}

	secondAdmission := make(chan error, 1)
	go func() {
		secondAdmission <- guard.AdmitDeleteSessions(context.Background(), plan)
	}()
	select {
	case <-store.admitCalls:
		t.Fatal("closure was released before the failed durable report was retried")
	case <-time.After(5 * time.Millisecond):
	}

	select {
	case succeeded := <-store.reportCalls:
		if !succeeded {
			t.Fatal("retried report changed its exact successful outcome")
		}
	case <-time.After(time.Second):
		t.Fatal("failed durable report was not retried")
	}
	select {
	case err := <-secondAdmission:
		if err != nil {
			t.Fatalf("second AdmitDeleteSessions() error=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("closure remained blocked after the durable report retry succeeded")
	}
	<-store.admitCalls
	guard.ReportDeleteSessions(context.Background(), agenthost.DeleteSessionsReport{Plan: plan})
}

type recordingDeletionAdmissionStore struct {
	admitted         executionbiz.SourceSessionDeletionAdmission
	admitErr         error
	reported         bool
	succeeded        bool
	reportContextErr error
}

func (store *recordingDeletionAdmissionStore) AdmitSourceSessionDeletion(
	_ context.Context,
	input executionbiz.SourceSessionDeletionAdmission,
) (executionbiz.SourceSessionDeletionAdmission, error) {
	store.admitted = input
	input.AdmissionID = "admission-1"
	return input, store.admitErr
}

func (store *recordingDeletionAdmissionStore) ReportSourceSessionDeletion(
	ctx context.Context,
	_ executionbiz.SourceSessionDeletionAdmission,
	succeeded bool,
	_ time.Time,
) error {
	store.reported = true
	store.succeeded = succeeded
	store.reportContextErr = ctx.Err()
	return nil
}

func (*recordingDeletionAdmissionStore) ReconcileSourceSessionDeletionAdmissions(
	_ context.Context, _ time.Time,
) error {
	return nil
}

type concurrentDeletionAdmissionStore struct {
	admitCalls chan struct{}
}

func (store *concurrentDeletionAdmissionStore) AdmitSourceSessionDeletion(
	_ context.Context,
	input executionbiz.SourceSessionDeletionAdmission,
) (executionbiz.SourceSessionDeletionAdmission, error) {
	store.admitCalls <- struct{}{}
	input.AdmissionID = "admission-1"
	return input, nil
}

func (*concurrentDeletionAdmissionStore) ReportSourceSessionDeletion(
	_ context.Context,
	_ executionbiz.SourceSessionDeletionAdmission,
	_ bool,
	_ time.Time,
) error {
	return nil
}

func (*concurrentDeletionAdmissionStore) ReconcileSourceSessionDeletionAdmissions(
	_ context.Context, _ time.Time,
) error {
	return nil
}

type retryingDeletionAdmissionStore struct {
	mu             sync.Mutex
	admitCalls     chan struct{}
	reportCalls    chan bool
	reportFailures int
}

func (store *retryingDeletionAdmissionStore) AdmitSourceSessionDeletion(
	_ context.Context,
	input executionbiz.SourceSessionDeletionAdmission,
) (executionbiz.SourceSessionDeletionAdmission, error) {
	store.admitCalls <- struct{}{}
	input.AdmissionID = "admission-1"
	return input, nil
}

func (store *retryingDeletionAdmissionStore) ReportSourceSessionDeletion(
	_ context.Context,
	_ executionbiz.SourceSessionDeletionAdmission,
	succeeded bool,
	_ time.Time,
) error {
	store.reportCalls <- succeeded
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.reportFailures > 0 {
		store.reportFailures--
		return errors.New("persist report")
	}
	return nil
}

func (*retryingDeletionAdmissionStore) ReconcileSourceSessionDeletionAdmissions(
	_ context.Context, _ time.Time,
) error {
	return nil
}
