package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type stubCatalogService struct {
	createFn func(context.Context, workspaceservice.CreateInput) (workspacebiz.Summary, error)
	deleteFn func(context.Context, string) (workspaceservice.DeleteResult, error)
	getFn    func(context.Context, string) (workspacebiz.Summary, error)
	listFn   func(context.Context) ([]workspacebiz.Summary, error)
	openFn   func(context.Context, string) (workspacebiz.Summary, error)
	startFn  func(context.Context) (*workspacebiz.Summary, error)
	updateFn func(context.Context, string, workspaceservice.UpdateInput) (workspacebiz.Summary, error)
}

type rejectingWorkbenchStore struct {
	t *testing.T
}

type stubFileService struct {
	createDirectoryFn      func(context.Context, string, string) (workspacefiles.FileEntry, error)
	createFileFn           func(context.Context, string, string) (workspacefiles.FileEntry, error)
	readFileFn             func(context.Context, string, string, int64) (workspacefiles.FileContent, error)
	writeTextFileFn        func(context.Context, string, string, string) (workspacefiles.FileEntry, error)
	deleteEntryFn          func(context.Context, string, string, workspacefiles.EntryKind) error
	getDirectoryTreeFn     func(context.Context, string, workspacefiles.DirectoryTreeSnapshotInput) (workspacefiles.DirectoryTreeSnapshot, error)
	listDirectoryFn        func(context.Context, string, workspacefiles.DirectoryListInput) (workspacefiles.DirectoryListing, error)
	listRecentFn           func(context.Context, string, workspacefiles.RecentListInput) (workspacefiles.DirectoryListing, error)
	moveEntryFn            func(context.Context, string, string, string) (workspacefiles.FileEntry, error)
	renameEntryFn          func(context.Context, string, string, string) (workspacefiles.FileEntry, error)
	preflightUploadFilesFn func(context.Context, string, workspacefiles.PreflightUploadInput) (workspacefiles.PreflightUploadResult, error)
	resolveRootFn          func(context.Context, string) (workspacefiles.WorkspaceRoot, error)
	resolveRootForPathFn   func(context.Context, string, string) (workspacefiles.WorkspaceRoot, error)
	searchFn               func(context.Context, string, workspacefiles.SearchInput) (workspacefiles.SearchResult, error)
	uploadFilesFn          func(context.Context, string, workspacefiles.UploadInput) (workspacefiles.UploadResult, error)
}

type stubPreferencesService struct {
	getFn func(context.Context) (preferencesbiz.DesktopPreferences, error)
	putFn func(context.Context, preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error)
}

type stubAppCenterService struct {
	launchFn func(context.Context, string, string) (workspacebiz.WorkspaceApp, error)
	retryFn  func(context.Context, string, string) (workspacebiz.WorkspaceApp, error)
}

type stubAgentSessionService struct {
	clearFn                  func(context.Context, string) (agentservice.ClearSessionsResult, error)
	composerOptionsFn        func(context.Context, agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error)
	createFn                 func(context.Context, string, agentservice.CreateSessionInput) (agentservice.Session, error)
	deleteFn                 func(context.Context, string, string) (bool, error)
	importExternalFn         func(context.Context, string, agentservice.ExternalImportInput) (agentservice.ExternalImportResult, error)
	validImportPathsFn       func(context.Context, agentservice.ExternalImportInput) ([]string, error)
	listFn                   func(context.Context, string, agentservice.ListSessionsInput) ([]agentservice.Session, error)
	listGeneratedFilesFn     func(context.Context, string, agentservice.ListGeneratedFilesInput) (agentservice.GeneratedFileList, error)
	listMessagesFn           func(context.Context, string, string, agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error)
	readAttachmentFn         func(context.Context, string, string, string) (agentservice.PromptAttachment, error)
	scanExternalFn           func(context.Context, agentservice.ExternalImportScanInput) (agentservice.ExternalImportScanResult, error)
	listGitBranchesFn        func(context.Context, string, string) (agentservice.GitBranches, error)
	listGitBranchesForPathFn func(context.Context, string, string) (agentservice.GitBranches, error)
	updatePinFn              func(context.Context, string, string, bool) (agentservice.Session, error)
	updateVisibleFn          func(context.Context, string, string, bool) (agentservice.Session, error)
	updateSettingsFn         func(context.Context, string, string, agentservice.ComposerSettingsPatch) (agentservice.Session, error)
}

func (stubAppCenterService) Add(context.Context, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubAppCenterService) DeletePackage(context.Context, string, string) error {
	return nil
}

func (stubAppCenterService) ExportPackage(context.Context, string, string, string) (workspaceservice.AppPackageArchiveResult, error) {
	return workspaceservice.AppPackageArchiveResult{}, nil
}

func (stubAppCenterService) ImportPackage(context.Context, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubAppCenterService) Install(context.Context, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (s stubAppCenterService) InstallWithOptions(ctx context.Context, workspaceID string, appID string, _ workspaceservice.InstallOptions) (workspacebiz.WorkspaceApp, error) {
	return s.Install(ctx, workspaceID, appID)
}

func (s stubAppCenterService) Launch(ctx context.Context, workspaceID string, appID string) (workspacebiz.WorkspaceApp, error) {
	if s.launchFn == nil {
		return workspacebiz.WorkspaceApp{}, nil
	}
	return s.launchFn(ctx, workspaceID, appID)
}

func (stubAppCenterService) LoadLocalPackage(context.Context, string, string, workspaceservice.InstallOptions) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubAppCenterService) ListReferences(context.Context, string, string, workspacebiz.AppReferenceListInput) (workspacebiz.AppReferenceListResult, error) {
	return workspacebiz.AppReferenceListResult{}, nil
}

func (stubAppCenterService) SearchReferences(context.Context, string, string, workspacebiz.AppReferenceSearchInput) (workspacebiz.AppReferenceListResult, error) {
	return workspacebiz.AppReferenceListResult{}, nil
}

func (stubAppCenterService) PrepareWorkspaceAppUpload(context.Context, string, string, workspaceservice.PrepareWorkspaceAppUploadInput) (workspaceservice.WorkspaceAppUploadSession, error) {
	return workspaceservice.WorkspaceAppUploadSession{}, nil
}

func (stubAppCenterService) PutWorkspaceAppUploadContent(context.Context, string, string, string, workspaceservice.PutWorkspaceAppUploadContentInput) error {
	return nil
}

func (stubAppCenterService) CompleteWorkspaceAppUpload(context.Context, string, string, string, time.Time) (workspaceservice.WorkspaceAppUploadedFile, error) {
	return workspaceservice.WorkspaceAppUploadedFile{}, nil
}

func (stubAppCenterService) CancelWorkspaceAppUpload(context.Context, string, string, string) error {
	return nil
}

func (stubAppCenterService) List(context.Context, string) ([]workspacebiz.WorkspaceApp, error) {
	return nil, nil
}

func (stubAppCenterService) CatalogLoadState() workspacebiz.AppCatalogLoadState {
	return workspacebiz.AppCatalogLoadState{}
}

func (stubAppCenterService) RefreshCatalog(context.Context, string) ([]workspacebiz.WorkspaceApp, error) {
	return nil, nil
}

func (stubAppCenterService) Remove(context.Context, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubAppCenterService) ReplaceIcon(context.Context, string, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubAppCenterService) ReloadLocalPackage(context.Context, string, string, workspaceservice.InstallOptions) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (s stubAppCenterService) Retry(ctx context.Context, workspaceID string, appID string) (workspacebiz.WorkspaceApp, error) {
	if s.retryFn == nil {
		return workspacebiz.WorkspaceApp{}, nil
	}
	return s.retryFn(ctx, workspaceID, appID)
}

func (stubAppCenterService) Rollback(context.Context, string, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubAppCenterService) StartEnabled(context.Context, string) ([]workspacebiz.WorkspaceApp, error) {
	return nil, nil
}

func (stubAppCenterService) StopAll(context.Context, string) ([]workspacebiz.WorkspaceApp, error) {
	return nil, nil
}

func (stubAppCenterService) Uninstall(context.Context, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubAgentSessionService) List(context.Context, string) ([]agentservice.Session, error) {
	return nil, nil
}

func (s stubAgentSessionService) ListFiltered(ctx context.Context, workspaceID string, input agentservice.ListSessionsInput) ([]agentservice.Session, error) {
	if s.listFn == nil {
		return nil, nil
	}
	return s.listFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) Clear(ctx context.Context, workspaceID string) (agentservice.ClearSessionsResult, error) {
	if s.clearFn == nil {
		return agentservice.ClearSessionsResult{}, nil
	}
	return s.clearFn(ctx, workspaceID)
}

func (s stubAgentSessionService) GetComposerOptions(ctx context.Context, input agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error) {
	if s.composerOptionsFn == nil {
		return agentservice.ComposerOptions{
			Provider:          input.Provider,
			EffectiveSettings: input.Settings,
		}, nil
	}
	return s.composerOptionsFn(ctx, input)
}

func (s stubAgentSessionService) ListMessages(ctx context.Context, workspaceID string, agentSessionID string, input agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error) {
	if s.listMessagesFn == nil {
		return agentservice.SessionMessagesPage{}, nil
	}
	return s.listMessagesFn(ctx, workspaceID, agentSessionID, input)
}

func (s stubAgentSessionService) ListGeneratedFiles(ctx context.Context, workspaceID string, input agentservice.ListGeneratedFilesInput) (agentservice.GeneratedFileList, error) {
	if s.listGeneratedFilesFn == nil {
		return agentservice.GeneratedFileList{WorkspaceID: workspaceID, Files: []agentservice.GeneratedFile{}}, nil
	}
	return s.listGeneratedFilesFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) ScanExternalImports(ctx context.Context, input agentservice.ExternalImportScanInput) (agentservice.ExternalImportScanResult, error) {
	if s.scanExternalFn == nil {
		return agentservice.ExternalImportScanResult{}, nil
	}
	return s.scanExternalFn(ctx, input)
}

func (s stubAgentSessionService) ImportExternalSessions(ctx context.Context, workspaceID string, input agentservice.ExternalImportInput) (agentservice.ExternalImportResult, error) {
	if s.importExternalFn == nil {
		return agentservice.ExternalImportResult{}, nil
	}
	return s.importExternalFn(ctx, workspaceID, input)
}

func (s stubAgentSessionService) ExternalImportValidProjectPaths(ctx context.Context, input agentservice.ExternalImportInput) ([]string, error) {
	if s.validImportPathsFn == nil {
		return nil, nil
	}
	return s.validImportPathsFn(ctx, input)
}

func (s stubAgentSessionService) Create(ctx context.Context, workspaceID string, input agentservice.CreateSessionInput) (agentservice.Session, error) {
	if s.createFn == nil {
		return agentservice.Session{}, nil
	}
	return s.createFn(ctx, workspaceID, input)
}

func (stubAgentSessionService) Get(context.Context, string, string) (agentservice.Session, error) {
	return agentservice.Session{}, nil
}

func (s stubAgentSessionService) ReadAttachment(ctx context.Context, workspaceID string, agentSessionID string, attachmentID string) (agentservice.PromptAttachment, error) {
	if s.readAttachmentFn != nil {
		return s.readAttachmentFn(ctx, workspaceID, agentSessionID, attachmentID)
	}
	return agentservice.PromptAttachment{}, nil
}

func (s stubAgentSessionService) ListGitBranches(ctx context.Context, workspaceID string, agentSessionID string) (agentservice.GitBranches, error) {
	if s.listGitBranchesFn != nil {
		return s.listGitBranchesFn(ctx, workspaceID, agentSessionID)
	}
	return agentservice.GitBranches{}, nil
}

func (s stubAgentSessionService) ListGitBranchesForPath(ctx context.Context, workspaceID string, workingDirectory string) (agentservice.GitBranches, error) {
	if s.listGitBranchesForPathFn != nil {
		return s.listGitBranchesForPathFn(ctx, workspaceID, workingDirectory)
	}
	return agentservice.GitBranches{}, nil
}

func (s stubAgentSessionService) Delete(ctx context.Context, workspaceID string, agentSessionID string) (bool, error) {
	if s.deleteFn == nil {
		return true, nil
	}
	return s.deleteFn(ctx, workspaceID, agentSessionID)
}

func (stubAgentSessionService) Cancel(context.Context, string, string) (agentservice.CancelSessionResult, error) {
	return agentservice.CancelSessionResult{}, nil
}

func (stubAgentSessionService) SendInput(context.Context, string, string, agentservice.SendInput) (agentservice.SendInputResult, error) {
	return agentservice.SendInputResult{}, nil
}

func (s stubAgentSessionService) UpdatePin(ctx context.Context, workspaceID string, agentSessionID string, pinned bool) (agentservice.Session, error) {
	if s.updatePinFn == nil {
		return agentservice.Session{}, nil
	}
	return s.updatePinFn(ctx, workspaceID, agentSessionID, pinned)
}

func (s stubAgentSessionService) UpdateVisible(ctx context.Context, workspaceID string, agentSessionID string, visible bool) (agentservice.Session, error) {
	if s.updateVisibleFn == nil {
		return agentservice.Session{}, nil
	}
	return s.updateVisibleFn(ctx, workspaceID, agentSessionID, visible)
}

func (s stubAgentSessionService) UpdateSettings(ctx context.Context, workspaceID string, agentSessionID string, settings agentservice.ComposerSettingsPatch) (agentservice.Session, error) {
	if s.updateSettingsFn == nil {
		return agentservice.Session{}, nil
	}
	return s.updateSettingsFn(ctx, workspaceID, agentSessionID, settings)
}

func (stubAgentSessionService) SubmitInteractive(context.Context, string, string, string, agentservice.SubmitInteractiveInput) (agentservice.Session, error) {
	return agentservice.Session{}, nil
}

func (s rejectingWorkbenchStore) GetWorkbenchSnapshot(context.Context, string) (workspacebiz.WorkbenchSnapshot, error) {
	s.t.Fatal("GetWorkbenchSnapshot should not be called")
	return workspacebiz.WorkbenchSnapshot{}, nil
}

func (s rejectingWorkbenchStore) PutWorkbenchSnapshot(context.Context, workspacebiz.WorkbenchSnapshot) error {
	s.t.Fatal("PutWorkbenchSnapshot should not be called for invalid workbench snapshots")
	return nil
}

func (s stubFileService) ResolveWorkspaceRoot(
	ctx context.Context,
	workspaceID string,
) (workspacefiles.WorkspaceRoot, error) {
	if s.resolveRootFn == nil {
		return workspacefiles.WorkspaceRoot{
			WorkspaceID:  workspaceID,
			LogicalRoot:  workspacefiles.DefaultLogicalRoot,
			PhysicalRoot: workspacefiles.DefaultLogicalRoot,
		}, nil
	}
	return s.resolveRootFn(ctx, workspaceID)
}

func (s stubFileService) ResolveWorkspaceRootForPath(
	ctx context.Context,
	workspaceID string,
	path string,
) (workspacefiles.WorkspaceRoot, error) {
	if s.resolveRootForPathFn == nil {
		return s.ResolveWorkspaceRoot(ctx, workspaceID)
	}
	return s.resolveRootForPathFn(ctx, workspaceID, path)
}

func (s stubFileService) ListDirectory(
	ctx context.Context,
	workspaceID string,
	input workspacefiles.DirectoryListInput,
) (workspacefiles.DirectoryListing, error) {
	if s.listDirectoryFn == nil {
		return workspacefiles.DirectoryListing{}, nil
	}
	return s.listDirectoryFn(ctx, workspaceID, input)
}

func (s stubFileService) ListRecent(
	ctx context.Context,
	workspaceID string,
	input workspacefiles.RecentListInput,
) (workspacefiles.DirectoryListing, error) {
	if s.listRecentFn == nil {
		return workspacefiles.DirectoryListing{}, nil
	}
	return s.listRecentFn(ctx, workspaceID, input)
}

func (s stubFileService) GetDirectoryTreeSnapshot(
	ctx context.Context,
	workspaceID string,
	input workspacefiles.DirectoryTreeSnapshotInput,
) (workspacefiles.DirectoryTreeSnapshot, error) {
	if s.getDirectoryTreeFn == nil {
		return workspacefiles.DirectoryTreeSnapshot{}, nil
	}
	return s.getDirectoryTreeFn(ctx, workspaceID, input)
}

func (s stubFileService) CreateFile(
	ctx context.Context,
	workspaceID string,
	path string,
) (workspacefiles.FileEntry, error) {
	if s.createFileFn == nil {
		return workspacefiles.FileEntry{}, nil
	}
	return s.createFileFn(ctx, workspaceID, path)
}

func (s stubFileService) ReadFile(
	ctx context.Context,
	workspaceID string,
	path string,
	maxBytes int64,
) (workspacefiles.FileContent, error) {
	if s.readFileFn == nil {
		return workspacefiles.FileContent{}, nil
	}
	return s.readFileFn(ctx, workspaceID, path, maxBytes)
}

func (s stubFileService) WriteTextFile(
	ctx context.Context,
	workspaceID string,
	path string,
	content string,
) (workspacefiles.FileEntry, error) {
	if s.writeTextFileFn == nil {
		return workspacefiles.FileEntry{}, nil
	}
	return s.writeTextFileFn(ctx, workspaceID, path, content)
}

func (s stubFileService) CreateDirectory(
	ctx context.Context,
	workspaceID string,
	path string,
) (workspacefiles.FileEntry, error) {
	if s.createDirectoryFn == nil {
		return workspacefiles.FileEntry{}, nil
	}
	return s.createDirectoryFn(ctx, workspaceID, path)
}

func (s stubFileService) DeleteEntry(
	ctx context.Context,
	workspaceID string,
	path string,
	kind workspacefiles.EntryKind,
) error {
	if s.deleteEntryFn == nil {
		return nil
	}
	return s.deleteEntryFn(ctx, workspaceID, path, kind)
}

func (s stubFileService) MoveEntry(
	ctx context.Context,
	workspaceID string,
	path string,
	targetDirectoryPath string,
) (workspacefiles.FileEntry, error) {
	if s.moveEntryFn == nil {
		return workspacefiles.FileEntry{}, nil
	}
	return s.moveEntryFn(ctx, workspaceID, path, targetDirectoryPath)
}

func (s stubFileService) RenameEntry(
	ctx context.Context,
	workspaceID string,
	path string,
	newName string,
) (workspacefiles.FileEntry, error) {
	if s.renameEntryFn != nil {
		return s.renameEntryFn(ctx, workspaceID, path, newName)
	}
	return workspacefiles.FileEntry{Path: workspacefiles.LogicalPath(path)}, nil
}

func (stubFileService) CopyEntry(
	_ context.Context,
	_ string,
	path string,
) (workspacefiles.FileEntry, error) {
	return workspacefiles.FileEntry{Path: workspacefiles.LogicalPath(path)}, nil
}

func (s stubFileService) PreflightUploadFiles(
	ctx context.Context,
	workspaceID string,
	input workspacefiles.PreflightUploadInput,
) (workspacefiles.PreflightUploadResult, error) {
	if s.preflightUploadFilesFn == nil {
		return workspacefiles.PreflightUploadResult{}, nil
	}
	return s.preflightUploadFilesFn(ctx, workspaceID, input)
}

func (s stubFileService) UploadFiles(
	ctx context.Context,
	workspaceID string,
	input workspacefiles.UploadInput,
) (workspacefiles.UploadResult, error) {
	if s.uploadFilesFn == nil {
		return workspacefiles.UploadResult{}, nil
	}
	return s.uploadFilesFn(ctx, workspaceID, input)
}

func (s stubFileService) Search(
	ctx context.Context,
	workspaceID string,
	input workspacefiles.SearchInput,
) (workspacefiles.SearchResult, error) {
	if s.searchFn == nil {
		return workspacefiles.SearchResult{}, nil
	}
	return s.searchFn(ctx, workspaceID, input)
}

func (s stubPreferencesService) Get(ctx context.Context) (preferencesbiz.DesktopPreferences, error) {
	if s.getFn == nil {
		return preferencesbiz.DefaultDesktopPreferences(), nil
	}
	return s.getFn(ctx)
}

func (s stubPreferencesService) Put(ctx context.Context, input preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error) {
	if s.putFn == nil {
		return preferencesbiz.DesktopPreferences{
			DefaultAgentProvider: input.DefaultAgentProvider,

			DockIconStyle:       "default",
			DockPlacement:       input.DockPlacement,
			Initialized:         true,
			Locale:              input.Locale,
			SleepPreventionMode: input.SleepPreventionMode,
			ThemeSource:         input.ThemeSource,
			UpdateChannel:       input.UpdateChannel,
			UpdatePolicy:        input.UpdatePolicy,
		}, nil
	}
	return s.putFn(ctx, input)
}

func TestDaemonAPIGeneratedRoutesWorkspaceTerminalsReturnServiceUnavailable(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/ws-1/terminals", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusServiceUnavailable, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.ServiceUnavailable,
		apierrors.ReasonWorkspaceTerminalUnavailable,
		"workspace terminal service is unavailable",
	)
}

func TestDaemonAPIGeneratedRoutesSearchWorkspaceIssueReferencesReturnServiceUnavailable(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-1/issue-references/search", map[string]any{"query": "login"})
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusServiceUnavailable, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.ServiceUnavailable,
		apierrors.ReasonWorkspaceIssueServiceUnavailable,
		"workspace issue-manager service is unavailable",
	)
}

func TestDaemonAPIGeneratedRoutesAgentSessionsReturnServiceUnavailable(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/ws-1/agent-sessions", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusServiceUnavailable, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.ServiceUnavailable,
		apierrors.ReasonWorkspaceAgentSessionUnavailable,
		"workspace agent session service is unavailable",
	)
}

func TestDaemonAPIGeneratedRoutesListAgentSessionsForwardsQuery(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			listFn: func(_ context.Context, workspaceID string, input agentservice.ListSessionsInput) ([]agentservice.Session, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if input.SearchQuery != "mention" || input.Limit != 30 || !input.VisibleOnly {
					t.Fatalf("list input = %#v, want searchQuery=mention limit=30 visibleOnly=true", input)
				}
				return []agentservice.Session{{
					ID:        "agent-session-1",
					Provider:  "codex",
					Cwd:       "/workspace",
					Status:    "working",
					Visible:   true,
					CreatedAt: time.UnixMilli(1000),
				}}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-sessions?searchQuery=mention&limit=30&visibleOnly=true",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
}

func TestDaemonAPIGeneratedRoutesListAgentSessionsRejectsLimitAboveContractMaximum(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			listGeneratedFilesFn: func(_ context.Context, workspaceID string, input agentservice.ListGeneratedFilesInput) (agentservice.GeneratedFileList, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if input.Query != "report" {
					t.Fatalf("query = %q, want report", input.Query)
				}
				if input.SessionCwd != "/workspace" {
					t.Fatalf("sessionCwd = %q, want /workspace", input.SessionCwd)
				}
				if input.Limit != 25 {
					t.Fatalf("limit = %d, want 25", input.Limit)
				}
				return agentservice.GeneratedFileList{
					WorkspaceID: workspaceID,
					Files: []agentservice.GeneratedFile{
						{
							Label: "report.md",
							Path:  "/workspace/report.md",
						},
					},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-sessions?limit=101",
		nil,
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		apierrors.ReasonMalformedRequest,
		"invalid agent session request",
	)
}

func TestDaemonAPIGeneratedRoutesReadAgentSessionAttachment(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			readAttachmentFn: func(_ context.Context, workspaceID string, agentSessionID string, attachmentID string) (agentservice.PromptAttachment, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if agentSessionID != "session-1" {
					t.Fatalf("agentSessionID = %q, want session-1", agentSessionID)
				}
				if attachmentID != "attachment-1" {
					t.Fatalf("attachmentID = %q, want attachment-1", attachmentID)
				}
				return agentservice.PromptAttachment{
					AttachmentID: attachmentID,
					MimeType:     "image/png",
					Data:         "aW1hZ2U=",
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-sessions/session-1/attachments/attachment-1",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionAttachmentResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.AttachmentId != "attachment-1" {
		t.Fatalf("attachmentId = %q, want attachment-1", response.AttachmentId)
	}
	if response.MimeType != tuttigenerated.WorkspaceAgentSessionAttachmentResponseMimeTypeImagepng {
		t.Fatalf("mimeType = %q, want image/png", response.MimeType)
	}
	if response.Data != "aW1hZ2U=" {
		t.Fatalf("data = %q, want base64 payload", response.Data)
	}
}

func TestDaemonAPIGeneratedRoutesReplaceWorkspaceAppIconReturnServiceUnavailable(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/apps/app-1/icon",
		map[string]any{"sourcePath": "/tmp/icon.png"},
	)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusServiceUnavailable, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.ServiceUnavailable,
		apierrors.ReasonWorkspaceAppUnavailable,
		"workspace app service is unavailable",
	)
}

func TestDaemonAPIGeneratedRoutesLaunchWorkspaceApp(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AppCenterService: stubAppCenterService{
			launchFn: func(_ context.Context, workspaceID string, appID string) (workspacebiz.WorkspaceApp, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if appID != "app-1" {
					t.Fatalf("appID = %q, want app-1", appID)
				}
				return workspaceAppForRouteTest(appID, workspacebiz.AppRuntimeStatusRunning), nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/apps/app-1/launch",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAppResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.App.AppId != "app-1" || response.App.Status != tuttigenerated.WorkspaceAppRuntimeStatusRunning {
		t.Fatalf("response app = %#v", response.App)
	}
}

func TestDaemonAPIGeneratedRoutesRetryWorkspaceAppMapsInvalidRuntimeState(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AppCenterService: stubAppCenterService{
			retryFn: func(context.Context, string, string) (workspacebiz.WorkspaceApp, error) {
				return workspacebiz.WorkspaceApp{}, workspaceservice.ErrInvalidWorkspaceAppRuntimeState
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/apps/app-1/retry",
		nil,
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		apierrors.ReasonMalformedRequest,
		workspaceservice.ErrInvalidWorkspaceAppRuntimeState.Error(),
	)
}

func TestDaemonAPIGeneratedRoutesCreateAgentSession(t *testing.T) {
	createdAt := time.Date(2026, 5, 30, 8, 0, 0, 0, time.UTC)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			createFn: func(_ context.Context, workspaceID string, input agentservice.CreateSessionInput) (agentservice.Session, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if input.Provider != "codex" {
					t.Fatalf("provider = %q, want codex", input.Provider)
				}
				if input.AgentSessionID != "11111111-1111-4111-8111-111111111111" {
					t.Fatalf("agent session id = %q", input.AgentSessionID)
				}
				return agentservice.Session{
					ID:        input.AgentSessionID,
					Provider:  "codex",
					Status:    "created",
					CreatedAt: createdAt,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-1/agent-sessions", map[string]any{
		"agentSessionId": "11111111-1111-4111-8111-111111111111",
		"initialContent": []map[string]any{{"type": "text", "text": "hello"}},
		"provider":       "codex",
	})
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Session.Id != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("session id = %q, want frontend UUID", response.Session.Id)
	}
}

func TestDaemonAPIGeneratedRoutesUpdateAgentSessionPin(t *testing.T) {
	createdAt := time.Date(2026, 5, 30, 8, 0, 0, 0, time.UTC)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			updatePinFn: func(_ context.Context, workspaceID string, agentSessionID string, pinned bool) (agentservice.Session, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if agentSessionID != "session-1" {
					t.Fatalf("agentSessionID = %q, want session-1", agentSessionID)
				}
				if !pinned {
					t.Fatal("pinned = false, want true")
				}
				return agentservice.Session{
					ID:             agentSessionID,
					Provider:       "codex",
					Status:         "created",
					PinnedAtUnixMS: 1700000000000,
					CreatedAt:      createdAt,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/agent-sessions/session-1/pin",
		map[string]any{"pinned": true},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Session.PinnedAtUnixMs == nil || *response.Session.PinnedAtUnixMs != 1700000000000 {
		t.Fatalf("pinnedAtUnixMs = %#v", response.Session.PinnedAtUnixMs)
	}
}

func TestDaemonAPIGeneratedRoutesUpdateAgentSessionVisibility(t *testing.T) {
	createdAt := time.Date(2026, 5, 30, 8, 0, 0, 0, time.UTC)
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			updateVisibleFn: func(_ context.Context, workspaceID string, agentSessionID string, visible bool) (agentservice.Session, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if agentSessionID != "session-1" {
					t.Fatalf("agentSessionID = %q, want session-1", agentSessionID)
				}
				if !visible {
					t.Fatal("visible = false, want true")
				}
				return agentservice.Session{
					ID:        agentSessionID,
					Provider:  "claude-code",
					Status:    "created",
					Visible:   visible,
					CreatedAt: createdAt,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/agent-sessions/session-1/visibility",
		map[string]any{"visible": true},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Session.Visible {
		t.Fatal("response visible = false, want true")
	}
}

func TestDaemonAPIGeneratedRoutesGetAgentProviderComposerOptions(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			composerOptionsFn: func(_ context.Context, input agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error) {
				if input.Locale != "zh-CN" {
					t.Fatalf("locale = %q, want zh-CN", input.Locale)
				}
				if input.Provider != "codex" {
					t.Fatalf("provider = %q, want codex", input.Provider)
				}
				if input.Cwd != "/workspace/project" {
					t.Fatalf("cwd = %q, want /workspace/project", input.Cwd)
				}
				if input.Settings.Model != "gpt-5" || input.Settings.ReasoningEffort != "high" {
					t.Fatalf("settings = %#v", input.Settings)
				}
				return agentservice.ComposerOptions{
					EffectiveSettings: input.Settings,
					ModelConfig: agentservice.ComposerConfigOption{
						Configurable: true,
						CurrentValue: "gpt-5",
						DefaultValue: "gpt-5",
						Options: []agentservice.ComposerConfigOptionValue{{
							ID:    "gpt-5",
							Label: "GPT-5",
							Value: "gpt-5",
						}},
					},
					PermissionConfig: agentservice.PermissionConfig{
						Configurable: true,
						DefaultValue: "auto",
						Modes: []agentservice.PermissionModeOption{{
							ID:          "auto",
							Label:       "替我审批",
							Description: "仅对检测到的风险操作请求批准",
							Semantic:    agentservice.PermissionModeSemanticAuto,
						}},
					},
					Provider: input.Provider,
					ReasoningConfig: agentservice.ComposerConfigOption{
						Configurable: true,
						CurrentValue: "high",
						DefaultValue: "high",
						Options: []agentservice.ComposerConfigOptionValue{{
							ID:    "high",
							Label: "高",
							Value: "high",
						}},
					},
					RuntimeContext: map[string]any{
						"configOptions": []map[string]any{
							{
								"currentValue": "gpt-5",
								"id":           "model",
								"options": []map[string]string{
									{"name": "GPT-5", "value": "gpt-5"},
								},
							},
						},
					},
					Skills: []agentservice.ComposerSkillOption{{
						Name:        "architecture-review",
						Trigger:     "$architecture-review",
						SourceKind:  "project",
						Description: "Review architecture changes",
					}},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-providers/codex/composer-options", map[string]any{
		"cwd":    "/workspace/project",
		"locale": "zh-CN",
		"settings": map[string]any{
			"model":            "gpt-5",
			"permissionModeId": "auto",
			"reasoningEffort":  "high",
		},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.AgentProviderComposerOptionsResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Provider != tuttigenerated.Codex {
		t.Fatalf("provider = %q, want codex", response.Provider)
	}
	if response.EffectiveSettings.Model == nil || *response.EffectiveSettings.Model != "gpt-5" {
		t.Fatalf("model = %#v, want gpt-5", response.EffectiveSettings.Model)
	}
	if response.ModelConfig.CurrentValue == nil || *response.ModelConfig.CurrentValue != "gpt-5" {
		t.Fatalf("modelConfig = %#v", response.ModelConfig)
	}
	if response.PermissionConfig.DefaultValue == nil || *response.PermissionConfig.DefaultValue != "auto" || response.PermissionConfig.Modes[0].Label != "替我审批" {
		t.Fatalf("permissionConfig = %#v", response.PermissionConfig)
	}
	if response.ReasoningConfig.Options[0].Label != "高" {
		t.Fatalf("reasoningConfig = %#v", response.ReasoningConfig)
	}
	if response.RuntimeContext["configOptions"] == nil {
		t.Fatalf("runtimeContext = %#v", response.RuntimeContext)
	}
	if len(response.Skills) != 1 || response.Skills[0].Trigger != "$architecture-review" || response.Skills[0].SourceKind != tuttigenerated.AgentProviderSkillOptionSourceKindProject {
		t.Fatalf("skills = %#v", response.Skills)
	}
}

func TestDaemonAPIGeneratedRoutesGetAgentProviderComposerOptionsUsesPreferencesDefaults(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			composerOptionsFn: func(_ context.Context, input agentservice.ComposerOptionsInput) (agentservice.ComposerOptions, error) {
				if input.Settings.Model != "gpt-5" ||
					input.Settings.PermissionModeID != "full-access" ||
					input.Settings.ReasoningEffort != "high" {
					t.Fatalf("settings = %#v", input.Settings)
				}
				return agentservice.ComposerOptions{
					EffectiveSettings: input.Settings,
					ModelConfig: agentservice.ComposerConfigOption{
						Configurable: true,
						CurrentValue: input.Settings.Model,
						DefaultValue: input.Settings.Model,
						Options: []agentservice.ComposerConfigOptionValue{{
							ID:    input.Settings.Model,
							Label: "GPT-5",
							Value: input.Settings.Model,
						}},
					},
					PermissionConfig: agentservice.PermissionConfig{
						Configurable: true,
						DefaultValue: input.Settings.PermissionModeID,
						Modes: []agentservice.PermissionModeOption{{
							ID:       input.Settings.PermissionModeID,
							Label:    "Full access",
							Semantic: agentservice.PermissionModeSemanticFullAccess,
						}},
					},
					Provider: input.Provider,
					ReasoningConfig: agentservice.ComposerConfigOption{
						Configurable: true,
						CurrentValue: input.Settings.ReasoningEffort,
						DefaultValue: input.Settings.ReasoningEffort,
						Options: []agentservice.ComposerConfigOptionValue{{
							ID:    input.Settings.ReasoningEffort,
							Label: "High",
							Value: input.Settings.ReasoningEffort,
						}},
					},
					RuntimeContext: map[string]any{},
				}, nil
			},
		},
		PreferencesService: stubPreferencesService{
			getFn: func(context.Context) (preferencesbiz.DesktopPreferences, error) {
				return preferencesbiz.DesktopPreferences{
					AgentComposerDefaultsByProvider: map[string]preferencesbiz.AgentComposerDefaults{
						"codex": {
							Model:            "gpt-5",
							PermissionModeID: "full-access",
							ReasoningEffort:  "high",
						},
					},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-providers/codex/composer-options", map[string]any{})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.AgentProviderComposerOptionsResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.EffectiveSettings.PermissionModeId == nil || *response.EffectiveSettings.PermissionModeId != "full-access" {
		t.Fatalf("effectiveSettings = %#v", response.EffectiveSettings)
	}
	if response.PermissionConfig.DefaultValue == nil || *response.PermissionConfig.DefaultValue != "full-access" {
		t.Fatalf("permissionConfig = %#v", response.PermissionConfig)
	}
}

func TestDaemonAPIGeneratedRoutesDeleteAgentSession(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			deleteFn: func(_ context.Context, workspaceID string, agentSessionID string) (bool, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if agentSessionID != "agent-session-1" {
					t.Fatalf("agentSessionID = %q, want agent-session-1", agentSessionID)
				}
				return true, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodDelete,
		"/v1/workspaces/ws-1/agent-sessions/agent-session-1",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.DeleteWorkspaceAgentSessionResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Removed {
		t.Fatal("removed = false, want true")
	}
}

func TestDaemonAPIGeneratedRoutesClearAgentSessions(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			clearFn: func(_ context.Context, workspaceID string) (agentservice.ClearSessionsResult, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				return agentservice.ClearSessionsResult{RemovedMessages: 5, RemovedSessions: 2}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodDelete,
		"/v1/workspaces/ws-1/agent-sessions",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.ClearWorkspaceAgentSessionsResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.RemovedSessions != 2 || response.RemovedMessages != 5 {
		t.Fatalf("response = %#v, want 2 sessions and 5 messages", response)
	}
}

func TestDaemonAPIGeneratedRoutesListAgentSessionMessages(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			listMessagesFn: func(_ context.Context, workspaceID string, agentSessionID string, input agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if agentSessionID != "agent-session-1" {
					t.Fatalf("agentSessionID = %q, want agent-session-1", agentSessionID)
				}
				if input.BeforeVersion != 9 {
					t.Fatalf("beforeVersion = %d, want 9", input.BeforeVersion)
				}
				if input.Order != agentactivitybiz.MessageOrderDesc {
					t.Fatalf("order = %q, want desc", input.Order)
				}
				if input.Limit != 25 {
					t.Fatalf("limit = %d, want 25", input.Limit)
				}
				return agentservice.SessionMessagesPage{
					AgentSessionID: agentSessionID,
					Messages: []agentservice.SessionMessage{
						{
							ID:              8,
							AgentSessionID:  agentSessionID,
							MessageID:       "msg-1",
							TurnID:          "turn-1",
							Role:            "assistant",
							Kind:            "text",
							Payload:         map[string]any{"content": "Done."},
							StartedAtUnixMS: 1717200001000,
							Version:         8,
						},
					},
					LatestVersion: 8,
					HasMore:       false,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-sessions/agent-session-1/messages?beforeVersion=9&order=desc&limit=25",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionMessagesResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if response.AgentSessionId != "agent-session-1" {
		t.Fatalf("agentSessionId = %q, want agent-session-1", response.AgentSessionId)
	}
	if response.LatestVersion != 8 {
		t.Fatalf("latestVersion = %d, want 8", response.LatestVersion)
	}
	if response.HasMore {
		t.Fatal("hasMore = true, want false")
	}
	if len(response.Messages) != 1 {
		t.Fatalf("len(messages) = %d, want 1", len(response.Messages))
	}
	if response.Messages[0].MessageId != "msg-1" {
		t.Fatalf("messageId = %q, want msg-1", response.Messages[0].MessageId)
	}
	if response.Messages[0].TurnId != "turn-1" {
		t.Fatalf("turnId = %q, want turn-1", response.Messages[0].TurnId)
	}
	if response.Messages[0].OccurredAtUnixMs != 1717200001000 {
		t.Fatalf("occurredAtUnixMs = %d, want startedAt fallback", response.Messages[0].OccurredAtUnixMs)
	}
}

func TestDaemonAPIGeneratedRoutesRejectTurnlessAgentSessionMessages(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			listMessagesFn: func(_ context.Context, _ string, agentSessionID string, _ agentservice.ListMessagesInput) (agentservice.SessionMessagesPage, error) {
				return agentservice.SessionMessagesPage{
					AgentSessionID: agentSessionID,
					Messages: []agentservice.SessionMessage{
						{
							ID:              8,
							AgentSessionID:  agentSessionID,
							MessageID:       "msg-turnless",
							Role:            "assistant",
							Kind:            "text",
							Payload:         map[string]any{"content": "Done."},
							StartedAtUnixMS: 1717200001000,
							Version:         8,
						},
					},
					LatestVersion: 8,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-sessions/agent-session-1/messages",
		nil,
	)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadGateway, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.WorkspaceOperationFailed,
		apierrors.ReasonWorkspaceOperationFailed,
		`workspace agent session message "msg-turnless" is missing turnId`,
	)
}

func TestDaemonAPIGeneratedRoutesListAgentGeneratedFiles(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			listGeneratedFilesFn: func(_ context.Context, workspaceID string, input agentservice.ListGeneratedFilesInput) (agentservice.GeneratedFileList, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if input.Query != "report" {
					t.Fatalf("query = %q, want report", input.Query)
				}
				if input.SessionCwd != "/workspace" {
					t.Fatalf("sessionCwd = %q, want /workspace", input.SessionCwd)
				}
				if input.Limit != 25 {
					t.Fatalf("limit = %d, want 25", input.Limit)
				}
				return agentservice.GeneratedFileList{
					WorkspaceID: workspaceID,
					Files: []agentservice.GeneratedFile{
						{
							Label: "report.md",
							Path:  "/workspace/report.md",
						},
					},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-generated-files?query=report&sessionCwd=/workspace&limit=25",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var response tuttigenerated.WorkspaceAgentGeneratedFileListResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if response.WorkspaceId != "ws-1" {
		t.Fatalf("workspaceId = %q, want ws-1", response.WorkspaceId)
	}
	if len(response.Entries) != 1 {
		t.Fatalf("len(entries) = %d, want 1", len(response.Entries))
	}
	if response.Entries[0].Path != "/workspace/report.md" {
		t.Fatalf("entry path = %q, want /workspace/report.md", response.Entries[0].Path)
	}
}

func TestDaemonAPIGeneratedRoutesGetDesktopPreferences(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		PreferencesService: stubPreferencesService{
			getFn: func(context.Context) (preferencesbiz.DesktopPreferences, error) {
				return preferencesbiz.DesktopPreferences{
					DefaultAgentProvider: "claude-code",

					DockIconStyle:       "default",
					DockPlacement:       "left",
					Initialized:         true,
					Locale:              "zh-CN",
					MinimizeAnimation:   "scale",
					SleepPreventionMode: "whileAgentRunning",
					ThemeSource:         "dark",
					UpdateChannel:       "rc",
					UpdatePolicy:        "auto",
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/preferences/desktop", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.DesktopPreferencesStateResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Initialized {
		t.Fatal("initialized = false, want true")
	}
	if response.Preferences.DockPlacement != tuttigenerated.Left {
		t.Fatalf("dockPlacement = %q, want %q", response.Preferences.DockPlacement, tuttigenerated.Left)
	}
	if response.Preferences.Locale != tuttigenerated.ZhCN {
		t.Fatalf("locale = %q, want %q", response.Preferences.Locale, tuttigenerated.ZhCN)
	}
	if response.Preferences.DefaultAgentProvider != tuttigenerated.ClaudeCode {
		t.Fatalf("defaultAgentProvider = %q, want %q", response.Preferences.DefaultAgentProvider, tuttigenerated.ClaudeCode)
	}
	if response.Preferences.ThemeSource != tuttigenerated.Dark {
		t.Fatalf("themeSource = %q, want %q", response.Preferences.ThemeSource, tuttigenerated.Dark)
	}
	if response.Preferences.SleepPreventionMode != tuttigenerated.WhileAgentRunning {
		t.Fatalf("sleepPreventionMode = %q, want %q", response.Preferences.SleepPreventionMode, tuttigenerated.WhileAgentRunning)
	}
	if response.Preferences.UpdateChannel != tuttigenerated.Rc {
		t.Fatalf("updateChannel = %q, want %q", response.Preferences.UpdateChannel, tuttigenerated.Rc)
	}
	if response.Preferences.UpdatePolicy != tuttigenerated.DesktopUpdatePolicyAuto {
		t.Fatalf("updatePolicy = %q, want %q", response.Preferences.UpdatePolicy, tuttigenerated.DesktopUpdatePolicyAuto)
	}
}

func TestDaemonAPIGeneratedRoutesPutDesktopPreferencesPersistsAgentGUIConversationRailPreference(t *testing.T) {
	mux := http.NewServeMux()
	var captured preferencesservice.PutInput
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		PreferencesService: stubPreferencesService{
			putFn: func(_ context.Context, input preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error) {
				captured = input
				return preferencesbiz.DesktopPreferences{
					AgentGUIConversationRailCollapsedByProvider: input.AgentGUIConversationRailCollapsedByProvider,
					AppCatalogChannel:    input.AppCatalogChannel,
					DefaultAgentProvider: input.DefaultAgentProvider,
					DockIconStyle:        input.DockIconStyle,
					DockPlacement:        input.DockPlacement,
					Initialized:          true,
					Locale:               input.Locale,
					SleepPreventionMode:  input.SleepPreventionMode,
					ThemeSource:          input.ThemeSource,
					UpdateChannel:        input.UpdateChannel,
					UpdatePolicy:         input.UpdatePolicy,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPut, "/v1/preferences/desktop", map[string]any{
		"preferences": map[string]any{
			"agentComposerDefaultsByProvider": map[string]any{},
			"agentGuiConversationRailCollapsedByProvider": map[string]any{
				"claude-code": false,
				"codex":       true,
			},
			"defaultAgentProvider": "codex",
			"appCatalogChannel":    "staging",
			"dockIconStyle":        "default",
			"dockPlacement":        "bottom",
			"locale":               "zh-CN",
			"minimizeAnimation":    "scale",
			"sleepPreventionMode":  "never",
			"themeSource":          "dark",
			"updateChannel":        "stable",
			"updatePolicy":         "prompt",
		},
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if !captured.AgentGUIConversationRailCollapsedByProvider["codex"] {
		t.Fatalf("captured rail preference = %#v, want codex true", captured.AgentGUIConversationRailCollapsedByProvider)
	}
	if collapsed, ok := captured.AgentGUIConversationRailCollapsedByProvider["claude-code"]; !ok || collapsed {
		t.Fatalf("captured rail preference = %#v, want claude-code false", captured.AgentGUIConversationRailCollapsedByProvider)
	}
	if captured.AppCatalogChannel != "staging" {
		t.Fatalf("captured appCatalogChannel = %q, want staging", captured.AppCatalogChannel)
	}
	var response tuttigenerated.DesktopPreferencesStateResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Preferences.AgentGuiConversationRailCollapsedByProvider.Codex == nil ||
		!*response.Preferences.AgentGuiConversationRailCollapsedByProvider.Codex {
		t.Fatalf("response rail codex = %#v, want true", response.Preferences.AgentGuiConversationRailCollapsedByProvider.Codex)
	}
	if response.Preferences.AgentGuiConversationRailCollapsedByProvider.ClaudeCode == nil ||
		*response.Preferences.AgentGuiConversationRailCollapsedByProvider.ClaudeCode {
		t.Fatalf("response rail claude-code = %#v, want false", response.Preferences.AgentGuiConversationRailCollapsedByProvider.ClaudeCode)
	}
	if response.Preferences.AppCatalogChannel != tuttigenerated.Staging {
		t.Fatalf("response appCatalogChannel = %q, want staging", response.Preferences.AppCatalogChannel)
	}
}

func TestDaemonAPIGeneratedRoutesPutDesktopPreferencesValidatesLocale(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		PreferencesService: stubPreferencesService{
			putFn: func(context.Context, preferencesservice.PutInput) (preferencesbiz.DesktopPreferences, error) {
				t.Fatal("Put should not be called for invalid locale")
				return preferencesbiz.DesktopPreferences{}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPut, "/v1/preferences/desktop", map[string]any{
		"preferences": map[string]any{
			"defaultAgentProvider": "codex",
			"appCatalogChannel":    "production",
			"dockIconStyle":        "default",
			"dockPlacement":        "bottom",
			"locale":               "fr",
			"minimizeAnimation":    "scale",
			"sleepPreventionMode":  "never",
			"themeSource":          "dark",
			"updateChannel":        "stable",
			"updatePolicy":         "prompt",
		},
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		"unsupported_desktop_locale",
		"desktop locale is unsupported",
	)
}

func TestDaemonAPIGeneratedRoutesSearchWorkspaceFilesRequiresQuery(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				searchFn: func(context.Context, string, workspacefiles.SearchInput) (workspacefiles.SearchResult, error) {
					t.Fatal("Search should not be called when query is missing")
					return workspacefiles.SearchResult{}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/ws-1/files/search", nil)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		"malformed_request",
		"Query argument query is required, but not found",
	)
}

func TestDaemonAPIGeneratedRoutesSearchWorkspaceFilesRejectsInvalidLimit(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				searchFn: func(context.Context, string, workspacefiles.SearchInput) (workspacefiles.SearchResult, error) {
					t.Fatal("Search should not be called when limit is invalid")
					return workspacefiles.SearchResult{}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/files/search?query=main&limit=nope",
		nil,
	)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		"malformed_request",
		"Invalid format for parameter limit: error binding string parameter: strconv.ParseInt: parsing \"nope\": invalid syntax",
	)
}

func TestDaemonAPIGeneratedRoutesSearchWorkspaceFilesForwardsIncludeHidden(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				searchFn: func(_ context.Context, workspaceID string, input workspacefiles.SearchInput) (workspacefiles.SearchResult, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if input.Query != "main" {
						t.Fatalf("query = %q, want main", input.Query)
					}
					if !input.IncludeHidden {
						t.Fatal("includeHidden = false, want true")
					}
					return workspacefiles.SearchResult{
						Entries: []workspacefiles.SearchEntry{},
					}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/files/search?query=main&includeHidden=true",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
}

func (s stubCatalogService) Create(ctx context.Context, input workspaceservice.CreateInput) (workspacebiz.Summary, error) {
	if s.createFn == nil {
		return workspacebiz.Summary{}, nil
	}
	return s.createFn(ctx, input)
}

func (s stubCatalogService) Delete(ctx context.Context, workspaceID string) (workspaceservice.DeleteResult, error) {
	if s.deleteFn == nil {
		return workspaceservice.DeleteResult{}, nil
	}
	return s.deleteFn(ctx, workspaceID)
}

func (s stubCatalogService) Get(ctx context.Context, workspaceID string) (workspacebiz.Summary, error) {
	if s.getFn == nil {
		return workspacebiz.Summary{}, nil
	}
	return s.getFn(ctx, workspaceID)
}

func (s stubCatalogService) List(ctx context.Context) ([]workspacebiz.Summary, error) {
	if s.listFn == nil {
		return nil, nil
	}
	return s.listFn(ctx)
}

func (s stubCatalogService) Open(ctx context.Context, workspaceID string) (workspacebiz.Summary, error) {
	if s.openFn == nil {
		return workspacebiz.Summary{}, nil
	}
	return s.openFn(ctx, workspaceID)
}

func (s stubCatalogService) Startup(ctx context.Context) (*workspacebiz.Summary, error) {
	if s.startFn == nil {
		return nil, nil
	}
	return s.startFn(ctx)
}

func (s stubCatalogService) Update(
	ctx context.Context,
	workspaceID string,
	input workspaceservice.UpdateInput,
) (workspacebiz.Summary, error) {
	if s.updateFn == nil {
		return workspacebiz.Summary{}, nil
	}
	return s.updateFn(ctx, workspaceID, input)
}

func TestDaemonAPIGeneratedRoutesListWorkspaces(t *testing.T) {
	lastOpenedAt := time.Date(2026, 5, 21, 8, 0, 0, 0, time.UTC)
	handler := generatedRouteHandler(stubCatalogService{
		listFn: func(context.Context) ([]workspacebiz.Summary, error) {
			return []workspacebiz.Summary{
				{
					ID:           "ws-1",
					Name:         "Workspace One",
					LastOpenedAt: &lastOpenedAt,
				},
			}, nil
		},
	})

	recorder := performGeneratedRouteRequest(t, handler, http.MethodGet, "/v1/workspaces", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}

	var response tuttigenerated.ListWorkspacesResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.TotalCount != 1 {
		t.Fatalf("totalCount = %d, want 1", response.TotalCount)
	}
	if len(response.Workspaces) != 1 {
		t.Fatalf("workspaces len = %d, want 1", len(response.Workspaces))
	}
	workspace := response.Workspaces[0]
	if workspace.Id != "ws-1" || workspace.Name != "Workspace One" {
		t.Fatalf("workspace = %#v", workspace)
	}
	if workspace.LastOpenedAt == nil || !workspace.LastOpenedAt.Equal(lastOpenedAt) {
		t.Fatalf("lastOpenedAt = %#v, want %s", workspace.LastOpenedAt, lastOpenedAt.Format(time.RFC3339))
	}
}

func TestDaemonAPIGeneratedRoutesCreateValidatesBody(t *testing.T) {
	handler := generatedRouteHandler(stubCatalogService{})

	recorder := performGeneratedRouteRequest(t, handler, http.MethodPost, "/v1/workspaces", map[string]string{
		"name": " ",
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		"missing_workspace_name",
		"workspace name is required",
	)
}

func TestDaemonAPIGeneratedRoutesMapWorkspaceNotFound(t *testing.T) {
	handler := generatedRouteHandler(stubCatalogService{
		getFn: func(context.Context, string) (workspacebiz.Summary, error) {
			return workspacebiz.Summary{}, workspacedata.ErrWorkspaceNotFound
		},
	})

	recorder := performGeneratedRouteRequest(t, handler, http.MethodGet, "/v1/workspaces/ws-missing", nil)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNotFound)
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.WorkspaceNotFound,
		"workspace_not_found",
		workspacedata.ErrWorkspaceNotFound.Error(),
	)
}

func TestDaemonAPIGeneratedRoutesCreateWorkspaceIssueMapsDuplicateIDTo409(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-route-1",
		Name: "Issue Route Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		IssueService: workspaceservice.IssueManagerService{Store: store},
	}))

	first := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-route-1/issues", map[string]any{
		"issueId": "issue-fixed",
		"topicId": workspaceissues.DefaultTopicID,
		"title":   "First issue",
	})
	if first.Code != http.StatusCreated {
		t.Fatalf("first status = %d, want %d; body: %s", first.Code, http.StatusCreated, first.Body.String())
	}

	second := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-route-1/issues", map[string]any{
		"issueId": "issue-fixed",
		"topicId": workspaceissues.DefaultTopicID,
		"title":   "Duplicate issue",
	})
	if second.Code != http.StatusConflict {
		t.Fatalf("second status = %d, want %d; body: %s", second.Code, http.StatusConflict, second.Body.String())
	}

	assertGeneratedRouteError(
		t,
		second,
		tuttigenerated.WorkspaceIssueResourceExists,
		apierrors.ReasonWorkspaceIssueExists,
		workspaceissues.ErrIssueAlreadyExists.Error(),
	)
}

func TestDaemonAPIGeneratedRoutesIssueTopicLifecycle(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-topic-route",
		Name: "Issue Topic Route Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		IssueService: workspaceservice.IssueManagerService{Store: store},
	}))

	create := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-topic-route/issue-topics", map[string]any{
		"summary": "Renderer migration issues",
		"title":   "Renderer",
		"topicId": "topic-renderer",
	})
	if create.Code != http.StatusCreated {
		t.Fatalf("create topic status = %d, want %d; body: %s", create.Code, http.StatusCreated, create.Body.String())
	}
	var createResponse tuttigenerated.IssueManagerTopicResponse
	decodeGeneratedRouteResponse(t, create, &createResponse)
	if createResponse.Topic.TopicId != "topic-renderer" || createResponse.Topic.Summary != "Renderer migration issues" {
		t.Fatalf("created topic = %+v", createResponse.Topic)
	}

	pinned := true
	update := performGeneratedRouteRequest(t, mux, http.MethodPatch, "/v1/workspaces/ws-issue-topic-route/issue-topics/topic-renderer", map[string]any{
		"pinned":  pinned,
		"summary": "Updated summary",
	})
	if update.Code != http.StatusOK {
		t.Fatalf("update topic status = %d, want %d; body: %s", update.Code, http.StatusOK, update.Body.String())
	}
	var updateResponse tuttigenerated.IssueManagerTopicResponse
	decodeGeneratedRouteResponse(t, update, &updateResponse)
	if updateResponse.Topic.PinnedAtUnix == 0 || updateResponse.Topic.Summary != "Updated summary" {
		t.Fatalf("updated topic = %+v", updateResponse.Topic)
	}

	list := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/ws-issue-topic-route/issue-topics", nil)
	if list.Code != http.StatusOK {
		t.Fatalf("list topic status = %d, want %d; body: %s", list.Code, http.StatusOK, list.Body.String())
	}
	var listResponse tuttigenerated.IssueManagerTopicListResponse
	decodeGeneratedRouteResponse(t, list, &listResponse)
	if len(listResponse.Topics) != 2 || listResponse.Topics[0].TopicId != "topic-renderer" {
		t.Fatalf("topic list = %+v", listResponse.Topics)
	}

	deleteTopic := performGeneratedRouteRequest(t, mux, http.MethodDelete, "/v1/workspaces/ws-issue-topic-route/issue-topics/topic-renderer", nil)
	if deleteTopic.Code != http.StatusOK {
		t.Fatalf("delete topic status = %d, want %d; body: %s", deleteTopic.Code, http.StatusOK, deleteTopic.Body.String())
	}
	var deleteResponse tuttigenerated.DeleteIssueManagerTopicResponse
	decodeGeneratedRouteResponse(t, deleteTopic, &deleteResponse)
	if !deleteResponse.Removed {
		t.Fatal("delete topic removed = false, want true")
	}

	nonEmptyTopic := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-topic-route/issue-topics", map[string]any{
		"title":   "Non empty",
		"topicId": "topic-non-empty",
	})
	if nonEmptyTopic.Code != http.StatusCreated {
		t.Fatalf("create non-empty topic status = %d, want %d; body: %s", nonEmptyTopic.Code, http.StatusCreated, nonEmptyTopic.Body.String())
	}
	issue := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-topic-route/issues", map[string]any{
		"title":   "Keep topic",
		"topicId": "topic-non-empty",
	})
	if issue.Code != http.StatusCreated {
		t.Fatalf("create issue status = %d, want %d; body: %s", issue.Code, http.StatusCreated, issue.Body.String())
	}
	deleteNonEmptyTopic := performGeneratedRouteRequest(t, mux, http.MethodDelete, "/v1/workspaces/ws-issue-topic-route/issue-topics/topic-non-empty", nil)
	if deleteNonEmptyTopic.Code != http.StatusConflict {
		t.Fatalf("delete non-empty topic status = %d, want %d; body: %s", deleteNonEmptyTopic.Code, http.StatusConflict, deleteNonEmptyTopic.Body.String())
	}
	assertGeneratedRouteError(
		t,
		deleteNonEmptyTopic,
		tuttigenerated.WorkspaceIssueResourceExists,
		apierrors.ReasonWorkspaceIssueTopicNotEmpty,
		workspaceissues.ErrTopicNotEmpty.Error(),
	)
}

func TestDaemonAPIGeneratedRoutesRequireIssueTopicID(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-topic-required",
		Name: "Issue Topic Required Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		IssueService: workspaceservice.IssueManagerService{Store: store},
	}))

	createMissingTopic := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-topic-required/issues", map[string]any{
		"title": "Missing topic",
	})
	if createMissingTopic.Code != http.StatusBadRequest {
		t.Fatalf("create missing topic status = %d, want %d; body: %s", createMissingTopic.Code, http.StatusBadRequest, createMissingTopic.Body.String())
	}

	listMissingTopic := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/ws-issue-topic-required/issues", nil)
	if listMissingTopic.Code != http.StatusBadRequest {
		t.Fatalf("list missing topic status = %d, want %d; body: %s", listMissingTopic.Code, http.StatusBadRequest, listMissingTopic.Body.String())
	}
}

func TestDaemonAPIGeneratedRoutesMapMissingIssueTopicTo404(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-topic-missing",
		Name: "Issue Topic Missing Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		IssueService: workspaceservice.IssueManagerService{Store: store},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-issue-topic-missing/issues", map[string]any{
		"title":   "Missing topic",
		"topicId": "missing-topic",
	})
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusNotFound, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.WorkspaceIssueResourceNotFound,
		apierrors.ReasonWorkspaceIssueTopicNotFound,
		workspaceissues.ErrTopicNotFound.Error(),
	)

	list := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/ws-issue-topic-missing/issues?topicId=missing-topic", nil)
	if list.Code != http.StatusNotFound {
		t.Fatalf("list status = %d, want %d; body: %s", list.Code, http.StatusNotFound, list.Body.String())
	}
	assertGeneratedRouteError(
		t,
		list,
		tuttigenerated.WorkspaceIssueResourceNotFound,
		apierrors.ReasonWorkspaceIssueTopicNotFound,
		workspaceissues.ErrTopicNotFound.Error(),
	)
}

func TestDaemonAPIGeneratedRoutesUpdateWorkspaceIssueStatus(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-route-status",
		Name: "Issue Route Status Workspace",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	issueService := workspaceservice.IssueManagerService{Store: store}
	issue, err := issueService.CreateIssue(ctx, "ws-issue-route-status", workspaceservice.CreateIssueManagerIssueInput{
		IssueID: "issue-status",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Mark me done",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{IssueService: issueService}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPatch,
		"/v1/workspaces/ws-issue-route-status/issues/issue-status",
		map[string]any{"status": "completed"},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.IssueManagerIssueResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Issue.Status != tuttigenerated.IssueManagerStatusCompleted {
		t.Fatalf("response issue status = %q", response.Issue.Status)
	}

	detail, err := issueService.GetIssueDetail(ctx, "ws-issue-route-status", issue.IssueID)
	if err != nil {
		t.Fatalf("GetIssueDetail() error = %v", err)
	}
	if detail.Issue.Status != workspaceissues.StatusCompleted {
		t.Fatalf("stored issue status = %q", detail.Issue.Status)
	}
}

func TestDaemonAPIGeneratedRoutesRemoveWorkspaceIssueTaskContextRef(t *testing.T) {
	store := openIssueRouteSQLiteStore(t)
	ctx := context.Background()
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-issue-route-2",
		Name: "Issue Route Workspace Two",
	}); err != nil {
		t.Fatalf("Create() workspace error = %v", err)
	}

	issueService := workspaceservice.IssueManagerService{Store: store}
	issue, err := issueService.CreateIssue(ctx, "ws-issue-route-2", workspaceservice.CreateIssueManagerIssueInput{
		IssueID: "issue-1",
		TopicID: workspaceissues.DefaultTopicID,
		Title:   "Scoped delete",
	})
	if err != nil {
		t.Fatalf("CreateIssue() error = %v", err)
	}
	task, err := issueService.CreateTask(ctx, "ws-issue-route-2", issue.IssueID, workspaceservice.CreateIssueManagerTaskInput{
		TaskID: "task-1",
		Title:  "Delete a ref",
	})
	if err != nil {
		t.Fatalf("CreateTask() error = %v", err)
	}
	refs, err := issueService.AddTaskContextRefs(ctx, "ws-issue-route-2", issue.IssueID, task.TaskID, workspaceservice.AddIssueManagerContextRefsInput{
		Refs: []workspaceissues.AddContextRefInput{{
			ContextRefID: "task-ref-1",
			RefType:      "file",
			Path:         "/workspace/docs/task.md",
		}},
	})
	if err != nil {
		t.Fatalf("AddTaskContextRefs() error = %v", err)
	}
	if len(refs) != 1 {
		t.Fatalf("refs len = %d, want 1", len(refs))
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{IssueService: issueService}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodDelete,
		"/v1/workspaces/ws-issue-route-2/issues/issue-1/tasks/task-1/context-refs/task-ref-1",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response struct {
		Removed bool `json:"removed"`
	}
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Removed {
		t.Fatal("removed = false, want true")
	}

	detail, err := issueService.GetTaskDetail(ctx, "ws-issue-route-2", issue.IssueID, task.TaskID)
	if err != nil {
		t.Fatalf("GetTaskDetail() error = %v", err)
	}
	if len(detail.ContextRefs) != 0 {
		t.Fatalf("task context refs len = %d, want 0", len(detail.ContextRefs))
	}
}

func TestDaemonAPIWorkbenchRejectsInvalidSnapshotBeforeStore(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			WorkbenchService: workspaceservice.WorkbenchService{
				Store: rejectingWorkbenchStore{t: t},
			},
		},
		),
	)

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPut, "/v1/workspaces/ws-1/workbench", map[string]any{
		"snapshot": map[string]any{
			"schemaVersion": 1,
			"nodes": []map[string]any{
				{
					"id":    "node-1",
					"kind":  "terminal",
					"title": "Terminal",
					"frame": map[string]any{
						"x":      10,
						"y":      20,
						"width":  120,
						"height": 240,
					},
				},
			},
		},
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
}

func TestDaemonAPIWorkbenchRejectsUnknownSnapshotFields(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			WorkbenchService: workspaceservice.WorkbenchService{
				Store: rejectingWorkbenchStore{t: t},
			},
		},
		),
	)

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPut, "/v1/workspaces/ws-1/workbench", map[string]any{
		"snapshot": map[string]any{
			"schemaVersion": 1,
			"nodes": []map[string]any{
				{
					"id":       "node-1",
					"kind":     "terminal",
					"title":    "Terminal",
					"position": map[string]any{"x": 10, "y": 20},
					"frame": map[string]any{
						"x":      10,
						"y":      20,
						"width":  320,
						"height": 240,
					},
				},
			},
		},
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.InvalidRequest,
		"malformed_request",
		"can't decode JSON body: json: unknown field \"position\"",
	)
}

func TestDaemonAPIGeneratedRoutesListWorkspaceFileDirectory(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				listDirectoryFn: func(_ context.Context, workspaceID string, input workspacefiles.DirectoryListInput) (workspacefiles.DirectoryListing, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if input.Path != "/workspace/src" {
						t.Fatalf("path = %q, want /workspace/src", input.Path)
					}
					if input.IncludeHidden {
						t.Fatal("includeHidden = true, want false")
					}
					size := int64(12)
					return workspacefiles.DirectoryListing{
						WorkspaceID:   workspaceID,
						Root:          "/workspace",
						DirectoryPath: "/workspace/src",
						Entries: []workspacefiles.FileEntry{
							{
								Path:      "/workspace/src/main.go",
								Name:      "main.go",
								Kind:      workspacefiles.EntryKindFile,
								SizeBytes: &size,
							},
						},
					}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/ws-1/files/directory?path=/workspace/src", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceFileDirectoryResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.WorkspaceId != "ws-1" || response.DirectoryPath != "/workspace/src" {
		t.Fatalf("response = %#v", response)
	}
	if len(response.Entries) != 1 || response.Entries[0].Path != "/workspace/src/main.go" {
		t.Fatalf("entries = %#v", response.Entries)
	}
}

func TestDaemonAPIGeneratedRoutesListWorkspaceRecentFiles(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				listRecentFn: func(_ context.Context, workspaceID string, input workspacefiles.RecentListInput) (workspacefiles.DirectoryListing, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if input.Limit != 5 {
						t.Fatalf("limit = %d, want 5", input.Limit)
					}
					lastUsed := int64(1700)
					return workspacefiles.DirectoryListing{
						WorkspaceID:   workspaceID,
						Root:          "/workspace",
						DirectoryPath: "/workspace",
						Entries: []workspacefiles.FileEntry{
							{
								Path:         "/workspace/src/main.go",
								Name:         "main.go",
								Kind:         workspacefiles.EntryKindFile,
								LastOpenedMs: &lastUsed,
							},
						},
					}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/ws-1/files/recent?limit=5", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceFileDirectoryResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.WorkspaceId != "ws-1" {
		t.Fatalf("response = %#v", response)
	}
	if len(response.Entries) != 1 || response.Entries[0].Path != "/workspace/src/main.go" {
		t.Fatalf("entries = %#v", response.Entries)
	}
}

func TestDaemonAPIGeneratedRoutesListWorkspaceFileDirectoryForwardsIncludeHidden(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				listDirectoryFn: func(_ context.Context, workspaceID string, input workspacefiles.DirectoryListInput) (workspacefiles.DirectoryListing, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if input.Path != "" {
						t.Fatalf("path = %q, want empty root path", input.Path)
					}
					if !input.IncludeHidden {
						t.Fatal("includeHidden = false, want true")
					}
					return workspacefiles.DirectoryListing{
						WorkspaceID:   workspaceID,
						Root:          "/workspace",
						DirectoryPath: "/workspace",
						Entries:       []workspacefiles.FileEntry{},
					}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/workspaces/ws-1/files/directory?includeHidden=true", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
}

func TestDaemonAPIGeneratedRoutesGetWorkspaceFileTreeSnapshot(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				getDirectoryTreeFn: func(_ context.Context, workspaceID string, input workspacefiles.DirectoryTreeSnapshotInput) (workspacefiles.DirectoryTreeSnapshot, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if input.Path != "/workspace/src" {
						t.Fatalf("path = %q, want /workspace/src", input.Path)
					}
					if !input.IncludeHidden {
						t.Fatal("includeHidden = false, want true")
					}
					if input.PrefetchDepth != 3 {
						t.Fatalf("prefetchDepth = %d, want 3", input.PrefetchDepth)
					}
					if input.PrefetchBudget != 250*time.Millisecond {
						t.Fatalf("prefetchBudget = %s, want 250ms", input.PrefetchBudget)
					}
					return workspacefiles.DirectoryTreeSnapshot{
						WorkspaceID:      workspaceID,
						Root:             "/workspace",
						PrefetchBudgetMs: 250,
						PrefetchDepth:    3,
						BudgetExceeded:   true,
						Directory: workspacefiles.DirectoryTreeDirectory{
							DirectoryPath: "/workspace/src",
							PrefetchState: workspacefiles.DirectoryTreePrefetchStatePartial,
							Entries: []workspacefiles.DirectoryTreeEntry{
								{
									Path:           "/workspace/src/app",
									Name:           "app",
									Kind:           workspacefiles.EntryKindDirectory,
									HasChildren:    true,
									PrefetchState:  workspacefiles.DirectoryTreePrefetchStateNotLoaded,
									PrefetchReason: workspacefiles.DirectoryTreePrefetchReasonBudgetExhausted,
								},
							},
						},
					}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/files/tree-snapshot?path=/workspace/src&includeHidden=true&prefetchDepth=3&prefetchBudgetMs=250",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceFileTreeSnapshotResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Directory.DirectoryPath != "/workspace/src" {
		t.Fatalf("directoryPath = %q, want /workspace/src", response.Directory.DirectoryPath)
	}
	if !response.BudgetExceeded || response.PrefetchDepth != 3 || response.PrefetchBudgetMs != 250 {
		t.Fatalf("response = %#v", response)
	}
	if len(response.Directory.Entries) != 1 || response.Directory.Entries[0].Path != "/workspace/src/app" {
		t.Fatalf("entries = %#v", response.Directory.Entries)
	}
}

func TestDaemonAPIGeneratedRoutesCreateWorkspaceFileDirectoryMapsMissingParentTo404(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				createDirectoryFn: func(_ context.Context, workspaceID string, path string) (workspacefiles.FileEntry, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if path != "/workspace/missing/notes" {
						t.Fatalf("path = %q, want /workspace/missing/notes", path)
					}
					return workspacefiles.FileEntry{}, workspacefiles.ErrEntryNotFound
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPut,
		"/v1/workspaces/ws-1/files/directory",
		map[string]any{"path": "/workspace/missing/notes"},
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusNotFound, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.WorkspaceFileNotFound,
		"workspace_file_not_found",
		workspacefiles.ErrEntryNotFound.Error(),
	)
}

func TestDaemonAPIGeneratedRoutesCreateWorkspaceFileMapsMissingParentTo404(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				createFileFn: func(_ context.Context, workspaceID string, path string) (workspacefiles.FileEntry, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if path != "/workspace/missing/todo.md" {
						t.Fatalf("path = %q, want /workspace/missing/todo.md", path)
					}
					return workspacefiles.FileEntry{}, workspacefiles.ErrEntryNotFound
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPut,
		"/v1/workspaces/ws-1/files/file",
		map[string]any{"path": "/workspace/missing/todo.md"},
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusNotFound, recorder.Body.String())
	}

	assertGeneratedRouteError(
		t,
		recorder,
		tuttigenerated.WorkspaceFileNotFound,
		"workspace_file_not_found",
		workspacefiles.ErrEntryNotFound.Error(),
	)
}

func TestDaemonAPIGeneratedRoutesReadWorkspaceFilePreview(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				readFileFn: func(_ context.Context, workspaceID string, path string, maxBytes int64) (workspacefiles.FileContent, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if path != "/workspace/docs/todo.md" {
						t.Fatalf("path = %q, want /workspace/docs/todo.md", path)
					}
					if maxBytes != workspacefiles.DefaultReadFileMaxBytes {
						t.Fatalf("maxBytes = %d, want %d", maxBytes, workspacefiles.DefaultReadFileMaxBytes)
					}
					return workspacefiles.FileContent{
						Bytes:     []byte("hello"),
						Name:      "todo.md",
						Path:      "/workspace/docs/todo.md",
						SizeBytes: 5,
					}, nil
				},
			},
		}),
	)

	request, err := http.NewRequest(
		http.MethodGet,
		"/v1/workspaces/ws-1/files/file/preview?path=%2Fworkspace%2Fdocs%2Ftodo.md",
		nil,
	)
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceFilePreviewResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Path != "/workspace/docs/todo.md" {
		t.Fatalf("path = %q", response.Path)
	}
	if response.BytesBase64 != "aGVsbG8=" {
		t.Fatalf("bytesBase64 = %q", response.BytesBase64)
	}
	if response.SizeBytes != 5 {
		t.Fatalf("sizeBytes = %d", response.SizeBytes)
	}
}

func TestDaemonAPIGeneratedRoutesReadWorkspaceFilePreviewUsesPathAwareRoot(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				readFileFn: func(_ context.Context, workspaceID string, path string, _ int64) (workspacefiles.FileContent, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if path != "/tmp/report.md" {
						t.Fatalf("path = %q, want /tmp/report.md", path)
					}
					return workspacefiles.FileContent{
						Bytes:     []byte("hello"),
						Name:      "report.md",
						Path:      "/tmp/report.md",
						SizeBytes: 5,
					}, nil
				},
				resolveRootForPathFn: func(_ context.Context, workspaceID string, path string) (workspacefiles.WorkspaceRoot, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if path != "/tmp/report.md" {
						t.Fatalf("root path = %q, want /tmp/report.md", path)
					}
					return workspacefiles.WorkspaceRoot{
						WorkspaceID:  workspaceID,
						LogicalRoot:  "/",
						PhysicalRoot: "/",
					}, nil
				},
			},
		}),
	)

	request, err := http.NewRequest(
		http.MethodGet,
		"/v1/workspaces/ws-1/files/file/preview?path=%2Ftmp%2Freport.md",
		nil,
	)
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceFilePreviewResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Root != "/" {
		t.Fatalf("root = %q, want /", response.Root)
	}
	if response.Path != "/tmp/report.md" {
		t.Fatalf("path = %q, want /tmp/report.md", response.Path)
	}
}

func TestDaemonAPIGeneratedRoutesWriteWorkspaceFileText(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				writeTextFileFn: func(_ context.Context, workspaceID string, path string, content string) (workspacefiles.FileEntry, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if path != "/workspace/docs/todo.md" {
						t.Fatalf("path = %q, want /workspace/docs/todo.md", path)
					}
					if content != "updated" {
						t.Fatalf("content = %q, want updated", content)
					}
					size := int64(len(content))
					return workspacefiles.FileEntry{
						Path:      "/workspace/docs/todo.md",
						Name:      "todo.md",
						Kind:      workspacefiles.EntryKindFile,
						SizeBytes: &size,
					}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPut,
		"/v1/workspaces/ws-1/files/file/text",
		map[string]any{"content": "updated", "path": "/workspace/docs/todo.md"},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceFileEntryResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Entry.Path != "/workspace/docs/todo.md" {
		t.Fatalf("entry path = %q", response.Entry.Path)
	}
	if response.Entry.SizeBytes == nil || *response.Entry.SizeBytes != int64(len("updated")) {
		t.Fatalf("entry size = %#v", response.Entry.SizeBytes)
	}
}

func TestDaemonAPIGeneratedRoutesRenameWorkspaceFileEntryUsesPathAwareRoot(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				renameEntryFn: func(_ context.Context, workspaceID string, path string, newName string) (workspacefiles.FileEntry, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if path != "/tmp/report.md" {
						t.Fatalf("path = %q, want /tmp/report.md", path)
					}
					if newName != "renamed.md" {
						t.Fatalf("newName = %q, want renamed.md", newName)
					}
					return workspacefiles.FileEntry{
						Path: "/tmp/renamed.md",
						Name: "renamed.md",
						Kind: workspacefiles.EntryKindFile,
					}, nil
				},
				resolveRootForPathFn: func(_ context.Context, workspaceID string, path string) (workspacefiles.WorkspaceRoot, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if path != "/tmp/renamed.md" {
						t.Fatalf("root path = %q, want /tmp/renamed.md", path)
					}
					return workspacefiles.WorkspaceRoot{
						WorkspaceID:  workspaceID,
						LogicalRoot:  "/",
						PhysicalRoot: "/",
					}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/files/entry/rename",
		map[string]any{"newName": "renamed.md", "path": "/tmp/report.md"},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceFileEntryResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Root != "/" {
		t.Fatalf("root = %q, want /", response.Root)
	}
	if response.Entry.Path != "/tmp/renamed.md" {
		t.Fatalf("entry path = %q, want /tmp/renamed.md", response.Entry.Path)
	}
}

func TestDaemonAPIGeneratedRoutesUploadWorkspaceFiles(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				uploadFilesFn: func(_ context.Context, workspaceID string, input workspacefiles.UploadInput) (workspacefiles.UploadResult, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if !input.Overwrite {
						t.Fatal("overwrite should be forwarded")
					}
					if input.TargetDirectoryPath != "/workspace/docs" {
						t.Fatalf("targetDirectoryPath = %q, want /workspace/docs", input.TargetDirectoryPath)
					}
					if len(input.SourcePaths) != 2 || input.SourcePaths[0] != "/tmp/a.txt" || input.SourcePaths[1] != "/tmp/b.txt" {
						t.Fatalf("sourcePaths = %#v", input.SourcePaths)
					}
					return workspacefiles.UploadResult{
						WorkspaceID:         workspaceID,
						Root:                "/workspace",
						TargetDirectoryPath: "/workspace/docs",
						Entries: []workspacefiles.FileEntry{
							{Path: "/workspace/docs/a.txt", Name: "a.txt", Kind: workspacefiles.EntryKindFile},
							{Path: "/workspace/docs/b.txt", Name: "b.txt", Kind: workspacefiles.EntryKindFile},
						},
					}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-1/files/upload", map[string]any{
		"overwrite":           true,
		"sourcePaths":         []string{"/tmp/a.txt", "/tmp/b.txt"},
		"targetDirectoryPath": "/workspace/docs",
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.UploadWorkspaceFilesResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.WorkspaceId != "ws-1" || response.TargetDirectoryPath != "/workspace/docs" || len(response.Entries) != 2 {
		t.Fatalf("response = %#v", response)
	}
}

func TestDaemonAPIGeneratedRoutesPreflightUploadWorkspaceFiles(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			FileService: stubFileService{
				preflightUploadFilesFn: func(_ context.Context, workspaceID string, input workspacefiles.PreflightUploadInput) (workspacefiles.PreflightUploadResult, error) {
					if workspaceID != "ws-1" {
						t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
					}
					if input.TargetDirectoryPath != "/workspace/docs" {
						t.Fatalf("targetDirectoryPath = %q, want /workspace/docs", input.TargetDirectoryPath)
					}
					if len(input.SourcePaths) != 1 || input.SourcePaths[0] != "/tmp/report.md" {
						t.Fatalf("sourcePaths = %#v", input.SourcePaths)
					}
					return workspacefiles.PreflightUploadResult{
						WorkspaceID:         workspaceID,
						Root:                "/workspace",
						TargetDirectoryPath: "/workspace/docs",
						Conflicts: []workspacefiles.UploadConflict{
							{
								DestinationKind: workspacefiles.EntryKindFile,
								DestinationPath: "/workspace/docs/report.md",
								Name:            "report.md",
								SourcePath:      "/tmp/report.md",
							},
						},
					}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/workspaces/ws-1/files/upload/preflight", map[string]any{
		"sourcePaths":         []string{"/tmp/report.md"},
		"targetDirectoryPath": "/workspace/docs",
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.PreflightUploadWorkspaceFilesResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if len(response.Conflicts) != 1 {
		t.Fatalf("conflicts len = %d, want 1", len(response.Conflicts))
	}
	if response.Conflicts[0].DestinationPath != "/workspace/docs/report.md" {
		t.Fatalf("destinationPath = %q, want /workspace/docs/report.md", response.Conflicts[0].DestinationPath)
	}
}

func generatedRouteHandler(service stubCatalogService) http.Handler {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{WorkspaceService: service}))
	return mux
}

func workspaceAppForRouteTest(appID string, status workspacebiz.AppRuntimeStatus) workspacebiz.WorkspaceApp {
	launchURL := "http://127.0.0.1:3000"
	port := 3000
	return workspacebiz.WorkspaceApp{
		Package: workspacebiz.AppPackage{
			AppID:   appID,
			Version: "0.1.0",
			Manifest: workspacebiz.AppManifest{
				AppID:       appID,
				Name:        "Test App",
				Description: "Test app",
			},
			Source: workspacebiz.AppPackageSourceImported,
		},
		Installation: &workspacebiz.AppInstallation{
			WorkspaceID: "ws-1",
			AppID:       appID,
			Enabled:     true,
		},
		Runtime: workspacebiz.AppRuntimeState{
			Status:    status,
			LaunchURL: &launchURL,
			Port:      &port,
		},
	}
}

func openIssueRouteSQLiteStore(t *testing.T) *workspacedata.SQLiteStore {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "tuttid.db")
	store, err := workspacedata.OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	return store
}

func performGeneratedRouteRequest(t *testing.T, handler http.Handler, method string, path string, body any) *httptest.ResponseRecorder {
	t.Helper()

	var requestBody *bytes.Reader
	if body == nil {
		requestBody = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("encode body: %v", err)
		}
		requestBody = bytes.NewReader(encoded)
	}

	request := httptest.NewRequest(method, path, requestBody)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeGeneratedRouteResponse(t *testing.T, recorder *httptest.ResponseRecorder, target any) {
	t.Helper()

	if err := json.NewDecoder(recorder.Body).Decode(target); err != nil {
		t.Fatalf("decode response: %v\nbody: %s", err, recorder.Body.String())
	}
}

func assertGeneratedRouteError(
	t *testing.T,
	recorder *httptest.ResponseRecorder,
	code tuttigenerated.ApiErrorDetailsCode,
	reason string,
	developerMessage string,
) {
	t.Helper()

	var response tuttigenerated.ApiErrorResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Error.Code != code {
		t.Fatalf("error.code = %q, want %q", response.Error.Code, code)
	}
	if response.Error.Reason == nil || *response.Error.Reason != reason {
		got := "<nil>"
		if response.Error.Reason != nil {
			got = *response.Error.Reason
		}
		t.Fatalf("error.reason = %q, want %q", got, reason)
	}
	if response.Error.DeveloperMessage == nil || *response.Error.DeveloperMessage != developerMessage {
		got := "<nil>"
		if response.Error.DeveloperMessage != nil {
			got = *response.Error.DeveloperMessage
		}
		t.Fatalf("error.developerMessage = %q, want %q", got, developerMessage)
	}
}
