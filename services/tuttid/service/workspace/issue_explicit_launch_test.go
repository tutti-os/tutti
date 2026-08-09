package workspace

import (
	"context"
	"errors"
	"testing"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

type recoverableIssueRunLauncher struct {
	err      error
	launches []IssueRunLaunch
}

func (launcher *recoverableIssueRunLauncher) Launch(_ context.Context, launch IssueRunLaunch) error {
	launcher.launches = append(launcher.launches, launch)
	return launcher.err
}

func TestStartIssueRunRecoversDeliveryUnknownWithStableIdentity(t *testing.T) {
	ctx := context.Background()
	store := openIssueServiceStore(t)
	const workspaceID = "workspace-explicit-launch-recovery"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Explicit launch recovery"}); err != nil {
		t.Fatal(err)
	}
	launcher := &recoverableIssueRunLauncher{err: errors.New("response lost after submit")}
	files := newMemoryIssueAttachmentFiles()
	service := IssueManagerService{
		AttachmentFiles: files,
		MutationLocks:   NewIssueMutationLocks(),
		RunLauncher:     launcher,
		Store:           store,
	}
	issue, err := service.CreateIssue(ctx, workspaceID, CreateIssueManagerIssueInput{
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Recover this launch",
		Content: "Use the original details",
		Attachments: []CreateIssueManagerImageAttachmentInput{{
			MimeType: "image/png",
			Data:     []byte("\x89PNG\r\n\x1a\ncontent"),
		}},
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	run, err := service.StartIssueRun(ctx, workspaceID, issue.IssueID, StartIssueManagerRunInput{
		AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatalf("StartIssueRun() delivery-unknown error = %v, want durable acceptance", err)
	}
	if len(launcher.launches) != 1 {
		t.Fatalf("initial launches = %d, want 1", len(launcher.launches))
	}
	detail, err := service.GetIssueDetail(ctx, workspaceID, issue.IssueID)
	if err != nil || len(detail.ContextRefs) != 1 {
		t.Fatalf("GetIssueDetail() refs = %#v, error = %v", detail.ContextRefs, err)
	}
	attachmentPath := detail.ContextRefs[0].Path
	if _, err := service.UpdateIssue(ctx, workspaceID, issue.IssueID, UpdateIssueManagerIssueInput{
		Title: "Edited after admission", HasTitle: true,
		Content: "Edited details", HasContent: true,
	}); err != nil {
		t.Fatalf("UpdateIssue() error = %v", err)
	}
	if _, err := service.RemoveIssueContextRef(ctx, workspaceID, issue.IssueID, detail.ContextRefs[0].ContextRefID); err != nil {
		t.Fatalf("RemoveIssueContextRef() error = %v", err)
	}
	if _, exists := files.files[attachmentPath]; !exists {
		t.Fatal("prepared launch attachment was deleted after ContextRef removal")
	}
	if removed, deleteErr := service.DeleteTask(ctx, workspaceID, issue.IssueID, run.TaskID); !errors.Is(deleteErr, ErrIssueRunLaunchPending) || removed {
		t.Fatalf("DeleteTask() removed = %v, error = %v, want pending-launch fence", removed, deleteErr)
	}
	if removed, deleteErr := service.DeleteIssue(ctx, workspaceID, issue.IssueID); !errors.Is(deleteErr, ErrIssueRunLaunchPending) || removed {
		t.Fatalf("DeleteIssue() removed = %v, error = %v, want pending-launch fence", removed, deleteErr)
	}
	if _, err := service.GetIssueDetail(ctx, workspaceID, issue.IssueID); err != nil {
		t.Fatalf("GetIssueDetail() after fenced deletion error = %v", err)
	}
	launcher.err = nil
	if err := service.RecoverExplicitIssueRunLaunches(ctx, workspaceID); err != nil {
		t.Fatalf("RecoverExplicitIssueRunLaunches() error = %v", err)
	}
	if len(launcher.launches) != 2 {
		t.Fatalf("recovered launches = %d, want 2", len(launcher.launches))
	}
	first, recovered := launcher.launches[0], launcher.launches[1]
	if first.RunID != run.RunID || recovered.RunID != run.RunID ||
		first.AgentSessionID != recovered.AgentSessionID ||
		first.ClientSubmitID != recovered.ClientSubmitID {
		t.Fatalf("launch identities changed: first=%#v recovered=%#v run=%#v", first, recovered, run)
	}
	if recovered.Prompt != first.Prompt || len(recovered.Attachments) != 1 ||
		recovered.Attachments[0].Path != attachmentPath {
		t.Fatalf("recovered payload changed: first=%#v recovered=%#v", first, recovered)
	}
	if _, exists := files.files[attachmentPath]; exists {
		t.Fatal("delivered launch attachment without a ContextRef was not cleaned up")
	}
	prepared, err := store.ListPreparedIssueRunLaunches(ctx, workspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if len(prepared) != 0 {
		t.Fatalf("prepared launches after delivery = %#v, want none", prepared)
	}
}

type contextRefFailureStore struct {
	workspaceissues.Store
	err error
}

type nthContextRefFailureStore struct {
	workspaceissues.Store
	err    error
	failAt int
	calls  int
}

func (store *nthContextRefFailureStore) ListContextRefs(
	ctx context.Context,
	workspaceID string,
	issueID string,
	taskID string,
	parentKind workspaceissues.ContextRefParentKind,
) ([]workspaceissues.ContextRef, error) {
	store.calls++
	if store.calls == store.failAt {
		return nil, store.err
	}
	return store.Store.ListContextRefs(ctx, workspaceID, issueID, taskID, parentKind)
}

func (store *contextRefFailureStore) ListContextRefs(
	ctx context.Context,
	workspaceID string,
	issueID string,
	taskID string,
	parentKind workspaceissues.ContextRefParentKind,
) ([]workspaceissues.ContextRef, error) {
	if store.err != nil {
		return nil, store.err
	}
	return store.Store.ListContextRefs(ctx, workspaceID, issueID, taskID, parentKind)
}

func TestDispatchEligibleIssueTasksReturnsContextRefFailure(t *testing.T) {
	ctx := context.Background()
	store := openIssueServiceStore(t)
	const workspaceID = "workspace-dispatch-context-ref-error"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Dispatch retry"}); err != nil {
		t.Fatal(err)
	}
	domain := workspaceissues.Service{Store: store}
	issue, err := domain.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID:         workspaceID,
		TopicID:             workspaceissues.DefaultTopicID,
		ActorUserID:         "local",
		Title:               "Retry attachment lookup",
		SequentialExecution: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := domain.CreateTask(ctx, workspaceissues.CreateTaskInput{
		WorkspaceID:   workspaceID,
		IssueID:       issue.IssueID,
		ActorUserID:   "local",
		Title:         "First",
		AgentTargetID: "local:codex",
	}); err != nil {
		t.Fatal(err)
	}
	wantErr := errors.New("context refs temporarily unavailable")
	launcher := &recoverableIssueRunLauncher{}
	failingStore := &contextRefFailureStore{Store: store, err: wantErr}
	service := IssueManagerService{
		MutationLocks: NewIssueMutationLocks(),
		RunLauncher:   launcher,
		Store:         failingStore,
	}
	if err := service.dispatchEligibleIssueTasks(ctx, workspaceID, issue.IssueID); !errors.Is(err, wantErr) {
		t.Fatalf("dispatchEligibleIssueTasks() error = %v, want %v", err, wantErr)
	}
	runs, err := domain.ListRuns(ctx, workspaceID, issue.IssueID, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 0 {
		t.Fatalf("runs after failed attachment lookup = %#v, want none", runs)
	}
	failingStore.err = nil
	if err := service.RecoverEligibleIssueDispatches(ctx, workspaceID); err != nil {
		t.Fatalf("RecoverEligibleIssueDispatches() error = %v", err)
	}
	if len(launcher.launches) != 1 {
		t.Fatalf("launches after recovery = %#v, want one", launcher.launches)
	}
}

func TestDispatchEligibleIssueTasksLaunchesClaimsBeforeLaterContextRefFailure(t *testing.T) {
	ctx := context.Background()
	store := openIssueServiceStore(t)
	const workspaceID = "workspace-partial-parallel-dispatch"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Partial parallel dispatch"}); err != nil {
		t.Fatal(err)
	}
	domain := workspaceissues.Service{Store: store}
	issue, err := domain.CreateIssue(ctx, workspaceissues.CreateIssueInput{
		WorkspaceID: workspaceID, TopicID: workspaceissues.DefaultTopicID,
		ActorUserID: "local", Title: "Launch committed prefix", ParallelExecution: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, title := range []string{"First", "Second"} {
		if _, err := domain.CreateTask(ctx, workspaceissues.CreateTaskInput{
			WorkspaceID: workspaceID, IssueID: issue.IssueID,
			ActorUserID: "local", Title: title, AgentTargetID: "local:codex",
		}); err != nil {
			t.Fatal(err)
		}
	}
	wantErr := errors.New("second attachment lookup failed")
	failingStore := &nthContextRefFailureStore{Store: store, err: wantErr, failAt: 4}
	launcher := &recoverableIssueRunLauncher{}
	service := IssueManagerService{
		MutationLocks: NewIssueMutationLocks(),
		RunLauncher:   launcher,
		Store:         failingStore,
	}
	if err := service.dispatchEligibleIssueTasks(ctx, workspaceID, issue.IssueID); !errors.Is(err, wantErr) {
		t.Fatalf("dispatchEligibleIssueTasks() error = %v, want %v", err, wantErr)
	}
	if len(launcher.launches) != 1 {
		t.Fatalf("launches = %#v, want committed prefix launch", launcher.launches)
	}
	runs, err := domain.ListRuns(ctx, workspaceID, issue.IssueID, "")
	if err != nil || len(runs) != 1 || runs[0].RunID != launcher.launches[0].RunID {
		t.Fatalf("Runs = %#v, launches = %#v, error = %v", runs, launcher.launches, err)
	}
}
