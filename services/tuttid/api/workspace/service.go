package workspace

import (
	"context"
	"time"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type CatalogService interface {
	List(context.Context) ([]workspacebiz.Summary, error)
	Startup(context.Context) (*workspacebiz.Summary, error)
	Create(context.Context, workspaceservice.CreateInput) (workspacebiz.Summary, error)
	Get(context.Context, string) (workspacebiz.Summary, error)
	Open(context.Context, string) (workspacebiz.Summary, error)
	Update(context.Context, string, workspaceservice.UpdateInput) (workspacebiz.Summary, error)
	Delete(context.Context, string) (workspaceservice.DeleteResult, error)
}

type WorkbenchService interface {
	GetSnapshot(context.Context, string) (workspacebiz.WorkbenchSnapshot, error)
	PutSnapshot(context.Context, string, workspaceservice.WorkbenchSnapshot) (workspacebiz.WorkbenchSnapshot, error)
}

type AppCenterService interface {
	Add(context.Context, string, string) (workspacebiz.WorkspaceApp, error)
	DeletePackage(context.Context, string, string) error
	ExportPackage(context.Context, string, string, string) (workspaceservice.AppPackageArchiveResult, error)
	ImportPackage(context.Context, string) (workspacebiz.WorkspaceApp, error)
	Install(context.Context, string, string) (workspacebiz.WorkspaceApp, error)
	InstallWithOptions(context.Context, string, string, workspaceservice.InstallOptions) (workspacebiz.WorkspaceApp, error)
	Launch(context.Context, string, string) (workspacebiz.WorkspaceApp, error)
	LoadLocalPackage(context.Context, string, string, workspaceservice.InstallOptions) (workspacebiz.WorkspaceApp, error)
	ListReferences(context.Context, string, string, workspacebiz.AppReferenceListInput) (workspacebiz.AppReferenceListResult, error)
	SearchReferences(context.Context, string, string, workspacebiz.AppReferenceSearchInput) (workspacebiz.AppReferenceListResult, error)
	PrepareWorkspaceAppUpload(context.Context, string, string, workspaceservice.PrepareWorkspaceAppUploadInput) (workspaceservice.WorkspaceAppUploadSession, error)
	PutWorkspaceAppUploadContent(context.Context, string, string, string, workspaceservice.PutWorkspaceAppUploadContentInput) error
	CompleteWorkspaceAppUpload(context.Context, string, string, string, time.Time) (workspaceservice.WorkspaceAppUploadedFile, error)
	CancelWorkspaceAppUpload(context.Context, string, string, string) error
	List(context.Context, string) ([]workspacebiz.WorkspaceApp, error)
	CatalogLoadState() workspacebiz.AppCatalogLoadState
	RefreshCatalog(context.Context, string) ([]workspacebiz.WorkspaceApp, error)
	Remove(context.Context, string, string) (workspacebiz.WorkspaceApp, error)
	ReplaceIcon(context.Context, string, string, string) (workspacebiz.WorkspaceApp, error)
	ReloadLocalPackage(context.Context, string, string, workspaceservice.InstallOptions) (workspacebiz.WorkspaceApp, error)
	Retry(context.Context, string, string) (workspacebiz.WorkspaceApp, error)
	Rollback(context.Context, string, string, string) (workspacebiz.WorkspaceApp, error)
	StartEnabled(context.Context, string) ([]workspacebiz.WorkspaceApp, error)
	StopAll(context.Context, string) ([]workspacebiz.WorkspaceApp, error)
	Uninstall(context.Context, string, string) (workspacebiz.WorkspaceApp, error)
}

type FileService interface {
	ResolveWorkspaceRoot(context.Context, string) (workspacefiles.WorkspaceRoot, error)
	ListDirectory(context.Context, string, workspacefiles.DirectoryListInput) (workspacefiles.DirectoryListing, error)
	ListRecent(context.Context, string, workspacefiles.RecentListInput) (workspacefiles.DirectoryListing, error)
	GetDirectoryTreeSnapshot(context.Context, string, workspacefiles.DirectoryTreeSnapshotInput) (workspacefiles.DirectoryTreeSnapshot, error)
	CreateFile(context.Context, string, string) (workspacefiles.FileEntry, error)
	ReadFile(context.Context, string, string, int64) (workspacefiles.FileContent, error)
	WriteTextFile(context.Context, string, string, string) (workspacefiles.FileEntry, error)
	CreateDirectory(context.Context, string, string) (workspacefiles.FileEntry, error)
	DeleteEntry(context.Context, string, string, workspacefiles.EntryKind) error
	MoveEntry(context.Context, string, string, string) (workspacefiles.FileEntry, error)
	RenameEntry(context.Context, string, string, string) (workspacefiles.FileEntry, error)
	CopyEntry(context.Context, string, string) (workspacefiles.FileEntry, error)
	PreflightUploadFiles(context.Context, string, workspacefiles.PreflightUploadInput) (workspacefiles.PreflightUploadResult, error)
	UploadFiles(context.Context, string, workspacefiles.UploadInput) (workspacefiles.UploadResult, error)
	Search(context.Context, string, workspacefiles.SearchInput) (workspacefiles.SearchResult, error)
}

type TerminalService interface {
	List(context.Context, string) ([]workspaceservice.TerminalSession, error)
	Create(context.Context, string, workspaceservice.CreateTerminalInput) (workspaceservice.TerminalSession, error)
	Get(context.Context, string, string) (workspaceservice.TerminalSession, error)
	Terminate(context.Context, string, string) (workspaceservice.TerminalSession, error)
	Resize(context.Context, string, string, workspaceservice.ResizeTerminalInput) (workspaceservice.TerminalSession, error)
	Write(context.Context, string, string, string) error
	AttachStream(context.Context, string, string, workspaceservice.AttachTerminalInput) (workspaceservice.TerminalStream, error)
	Snapshot(context.Context, string, string) (workspaceservice.TerminalSnapshot, error)
	CloseGuard(context.Context, string, string) (workspaceservice.TerminalCloseGuard, error)
}

type IssueManagerService interface {
	ListTopics(context.Context, string) (workspaceissues.TopicList, error)
	CreateTopic(context.Context, string, workspaceservice.CreateIssueManagerTopicInput) (workspaceissues.Topic, error)
	UpdateTopic(context.Context, string, string, workspaceservice.UpdateIssueManagerTopicInput) (workspaceissues.Topic, error)
	DeleteTopic(context.Context, string, string) (bool, error)
	ListIssues(context.Context, string, workspaceservice.ListIssueManagerItemsInput) (workspaceissues.IssueList, error)
	CreateIssue(context.Context, string, workspaceservice.CreateIssueManagerIssueInput) (workspaceissues.Issue, error)
	GetIssueDetail(context.Context, string, string) (workspaceissues.IssueDetail, error)
	SearchIssueOutputs(context.Context, workspaceissues.RunOutputSearchParams) ([]workspaceissues.RunOutputSearchHit, error)
	UpdateIssue(context.Context, string, string, workspaceservice.UpdateIssueManagerIssueInput) (workspaceissues.Issue, error)
	CancelIssueExecution(context.Context, string, string) (int, error)
	DeleteIssue(context.Context, string, string) (bool, error)
	AddIssueContextRefs(context.Context, string, string, workspaceservice.AddIssueManagerContextRefsInput) ([]workspaceissues.ContextRef, error)
	ListTasks(context.Context, string, string, workspaceservice.ListIssueManagerItemsInput) (workspaceissues.TaskList, error)
	CreateTask(context.Context, string, string, workspaceservice.CreateIssueManagerTaskInput) (workspaceissues.Task, error)
	CreateTasks(context.Context, string, string, workspaceservice.CreateIssueManagerTasksInput) ([]workspaceissues.Task, error)
	GetTaskDetail(context.Context, string, string, string) (workspaceissues.TaskDetail, error)
	UpdateTask(context.Context, string, string, string, workspaceservice.UpdateIssueManagerTaskInput) (workspaceissues.Task, error)
	DeleteTask(context.Context, string, string, string) (bool, error)
	AddTaskContextRefs(context.Context, string, string, string, workspaceservice.AddIssueManagerContextRefsInput) ([]workspaceissues.ContextRef, error)
	ListRuns(context.Context, string, string, string) ([]workspaceissues.Run, error)
	CreateRun(context.Context, string, string, string, workspaceservice.CreateIssueManagerRunInput) (workspaceissues.Run, error)
	GetRunDetail(context.Context, string, string, string, string) (workspaceissues.RunDetail, error)
	CompleteRun(context.Context, string, string, string, string, workspaceservice.CompleteIssueManagerRunInput) (workspaceissues.RunDetail, error)
	RemoveIssueContextRef(context.Context, string, string, string) (bool, error)
	RemoveTaskContextRef(context.Context, string, string, string, string) (bool, error)
}
