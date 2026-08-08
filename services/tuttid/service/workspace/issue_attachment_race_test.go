package workspace

import (
	"context"
	"errors"
	"runtime"
	"testing"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

type coordinatedIssueAdmissionStore struct {
	workspaceissues.Store
	issueRunLaunchIntentStore
	createRunEntered      chan struct{}
	continueCreateRun     chan struct{}
	createIntentEntered   chan struct{}
	continueCreateIntent  chan struct{}
	contextRemovalEntered chan struct{}
}

func (store *coordinatedIssueAdmissionStore) CreateRun(
	ctx context.Context,
	run workspaceissues.Run,
) (workspaceissues.Run, error) {
	if store.createRunEntered != nil {
		close(store.createRunEntered)
		<-store.continueCreateRun
	}
	return store.Store.CreateRun(ctx, run)
}

func (store *coordinatedIssueAdmissionStore) CreateIssueRunWithLaunchIntent(
	ctx context.Context,
	prepared workspaceissues.PreparedRun,
	clientSubmitID string,
	payloadJSON string,
) (workspaceissues.Run, error) {
	if store.createIntentEntered != nil {
		close(store.createIntentEntered)
		<-store.continueCreateIntent
	}
	return store.issueRunLaunchIntentStore.CreateIssueRunWithLaunchIntent(
		ctx, prepared, clientSubmitID, payloadJSON,
	)
}

func (store *coordinatedIssueAdmissionStore) RemoveContextRef(
	ctx context.Context,
	workspaceID, issueID, taskID string,
	parentKind workspaceissues.ContextRefParentKind,
	contextRefID string,
) (bool, error) {
	if store.contextRemovalEntered != nil {
		close(store.contextRemovalEntered)
	}
	return store.Store.RemoveContextRef(
		ctx, workspaceID, issueID, taskID, parentKind, contextRefID,
	)
}

func (store *coordinatedIssueAdmissionStore) HasIssueAttachmentReferencePath(
	ctx context.Context,
	path string,
) (bool, error) {
	reader, ok := store.Store.(issueAttachmentReferenceReader)
	if !ok {
		return false, workspaceissues.ErrStoreNotConfigured
	}
	return reader.HasIssueAttachmentReferencePath(ctx, path)
}

type blockingAttachmentCopyLauncher struct {
	files      *memoryIssueAttachmentFiles
	entered    chan struct{}
	continueCh chan struct{}
	copied     bool
}

func (launcher *blockingAttachmentCopyLauncher) Launch(_ context.Context, launch IssueRunLaunch) error {
	close(launcher.entered)
	<-launcher.continueCh
	if len(launch.Attachments) != 1 {
		return errors.New("launch attachment snapshot is incomplete")
	}
	_, launcher.copied = launcher.files.files[launch.Attachments[0].Path]
	if !launcher.copied {
		return errors.New("launch attachment source was removed before copy")
	}
	return nil
}

func waitForIssueMutationLockRefs(
	t *testing.T,
	locks *IssueMutationLocks,
	workspaceID, issueID string,
	want int,
) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	key := workspaceID + "/" + issueID
	for {
		locks.mu.Lock()
		refs := 0
		if lock := locks.locks[key]; lock != nil {
			refs = lock.refs
		}
		locks.mu.Unlock()
		if refs >= want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("Issue mutation lock refs = %d, want at least %d", refs, want)
		}
		runtime.Gosched()
	}
}

func TestRemoveIssueContextRefWaitsForExplicitRunAdmission(t *testing.T) {
	ctx := context.Background()
	store := openIssueServiceStore(t)
	const workspaceID = "workspace-issue-ref-admission-race"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Issue ref admission race"}); err != nil {
		t.Fatal(err)
	}
	files := newMemoryIssueAttachmentFiles()
	baseService := IssueManagerService{Store: store, AttachmentFiles: files}
	issue, err := baseService.CreateIssue(ctx, workspaceID, CreateIssueManagerIssueInput{
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Keep admitted screenshot",
		Attachments: []CreateIssueManagerImageAttachmentInput{{
			MimeType: "image/png",
			Data:     []byte("\x89PNG\r\n\x1a\ncontent"),
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	detail, err := baseService.GetIssueDetail(ctx, workspaceID, issue.IssueID)
	if err != nil || len(detail.ContextRefs) != 1 {
		t.Fatalf("GetIssueDetail() refs = %#v, error = %v", detail.ContextRefs, err)
	}
	attachmentPath := detail.ContextRefs[0].Path
	wrapped := &coordinatedIssueAdmissionStore{
		Store:                     store,
		issueRunLaunchIntentStore: store,
		createIntentEntered:       make(chan struct{}),
		continueCreateIntent:      make(chan struct{}),
		contextRemovalEntered:     make(chan struct{}),
	}
	locks := NewIssueMutationLocks()
	service := IssueManagerService{
		Store: wrapped, AttachmentFiles: files, MutationLocks: locks,
		RunLauncher: &recoverableIssueRunLauncher{err: errors.New("delivery response lost")},
	}
	startDone := make(chan error, 1)
	go func() {
		_, startErr := service.StartIssueRun(ctx, workspaceID, issue.IssueID, StartIssueManagerRunInput{
			AgentTargetID: "local:codex",
		})
		startDone <- startErr
	}()
	<-wrapped.createIntentEntered
	removeDone := make(chan error, 1)
	go func() {
		_, removeErr := service.RemoveIssueContextRef(
			ctx, workspaceID, issue.IssueID, detail.ContextRefs[0].ContextRefID,
		)
		removeDone <- removeErr
	}()
	waitForIssueMutationLockRefs(t, locks, workspaceID, issue.IssueID, 2)
	select {
	case <-wrapped.contextRemovalEntered:
		t.Fatal("Issue ContextRef removal entered the store before Run admission committed")
	default:
	}
	close(wrapped.continueCreateIntent)
	if err := <-startDone; err != nil {
		t.Fatalf("StartIssueRun() error = %v", err)
	}
	if err := <-removeDone; err != nil {
		t.Fatalf("RemoveIssueContextRef() error = %v", err)
	}
	if _, exists := files.files[attachmentPath]; !exists {
		t.Fatal("prepared explicit launch did not pin the concurrently removed Issue attachment")
	}
}

func TestRemoveTaskContextRefWaitsForAutomaticRunAdmissionAndCopy(t *testing.T) {
	ctx := context.Background()
	store := openIssueServiceStore(t)
	const workspaceID = "workspace-task-ref-admission-race"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Task ref admission race"}); err != nil {
		t.Fatal(err)
	}
	files := newMemoryIssueAttachmentFiles()
	baseService := IssueManagerService{Store: store, AttachmentFiles: files}
	issue, err := baseService.CreateIssue(ctx, workspaceID, CreateIssueManagerIssueInput{
		TopicID:             workspaceissues.DefaultTopicID,
		Title:               "Dispatch with task screenshot",
		SequentialExecution: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	task, err := baseService.CreateTask(ctx, workspaceID, issue.IssueID, CreateIssueManagerTaskInput{
		Title: "Inspect task screenshot", AgentTargetID: "local:codex",
	})
	if err != nil {
		t.Fatal(err)
	}
	refs, err := baseService.persistIssueAttachments([]CreateIssueManagerImageAttachmentInput{{
		MimeType: "image/png", Data: []byte("\x89PNG\r\n\x1a\ncontent"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	added, err := baseService.AddTaskContextRefs(ctx, workspaceID, issue.IssueID, task.TaskID, AddIssueManagerContextRefsInput{Refs: refs})
	if err != nil || len(added) != 1 {
		t.Fatalf("AddTaskContextRefs() refs = %#v, error = %v", added, err)
	}
	attachmentPath := added[0].Path
	wrapped := &coordinatedIssueAdmissionStore{
		Store:                     store,
		issueRunLaunchIntentStore: store,
		createRunEntered:          make(chan struct{}),
		continueCreateRun:         make(chan struct{}),
		contextRemovalEntered:     make(chan struct{}),
	}
	locks := NewIssueMutationLocks()
	launcher := &blockingAttachmentCopyLauncher{
		files: files, entered: make(chan struct{}), continueCh: make(chan struct{}),
	}
	service := IssueManagerService{
		Store: wrapped, AttachmentFiles: files,
		AttachmentLaunchPins: NewIssueAttachmentLaunchPins(),
		MutationLocks:        locks, RunLauncher: launcher,
	}
	dispatchDone := make(chan error, 1)
	go func() { dispatchDone <- service.dispatchEligibleIssueTasks(ctx, workspaceID, issue.IssueID) }()
	<-wrapped.createRunEntered
	removeDone := make(chan error, 1)
	go func() {
		_, removeErr := service.RemoveTaskContextRef(
			ctx, workspaceID, issue.IssueID, task.TaskID, added[0].ContextRefID,
		)
		removeDone <- removeErr
	}()
	waitForIssueMutationLockRefs(t, locks, workspaceID, issue.IssueID, 2)
	select {
	case <-wrapped.contextRemovalEntered:
		t.Fatal("Task ContextRef removal entered the store before automatic Run admission committed")
	default:
	}
	close(wrapped.continueCreateRun)
	<-launcher.entered
	if err := <-removeDone; err != nil {
		t.Fatalf("RemoveTaskContextRef() error = %v", err)
	}
	if _, exists := files.files[attachmentPath]; !exists {
		t.Fatal("in-flight automatic launch did not pin the removed Task attachment")
	}
	close(launcher.continueCh)
	if err := <-dispatchDone; err != nil {
		t.Fatalf("dispatchEligibleIssueTasks() error = %v", err)
	}
	if !launcher.copied {
		t.Fatal("Agent adapter did not copy the pinned Task attachment")
	}
	if _, exists := files.files[attachmentPath]; exists {
		t.Fatal("automatic launch attachment was not cleaned after copy and ContextRef removal")
	}
}
