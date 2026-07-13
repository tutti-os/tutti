package workspace

import (
	"context"
	"errors"

	agentstore "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	managedcredentialsbiz "github.com/tutti-os/tutti/services/tuttid/biz/managedcredentials"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

var ErrWorkspaceNotFound = errors.New("workspace not found")
var ErrWorkbenchSnapshotNotFound = errors.New("workspace workbench snapshot not found")
var ErrWorkspaceAppNotFound = errors.New("workspace app not found")
var ErrWorkspaceAppFactoryJobNotFound = errors.New("workspace app factory job not found")

// ErrAgentTargetNotFound aliases the embedded agent store's sentinel so
// existing errors.Is checks keep working across the delegation boundary.
var ErrAgentTargetNotFound = agentstore.ErrAgentTargetNotFound

type CatalogStore interface {
	Create(context.Context, workspacebiz.Summary) error
	Delete(context.Context, string) error
	Get(context.Context, string) (workspacebiz.Summary, error)
	GetStartup(context.Context) (*workspacebiz.Summary, error)
	List(context.Context) ([]workspacebiz.Summary, error)
	Open(context.Context, string) (workspacebiz.Summary, error)
	Update(context.Context, workspacebiz.Summary) error
}

type WorkbenchStore interface {
	GetWorkbenchSnapshot(context.Context, string) (workspacebiz.WorkbenchSnapshot, error)
	PutWorkbenchSnapshot(context.Context, workspacebiz.WorkbenchSnapshot) error
}

type AgentActivityStore interface {
	agentactivitybiz.Repository
	PrepareSubmitClaim(context.Context, agentactivitybiz.SubmitClaimPrepare) (agentactivitybiz.SubmitClaim, bool, error)
	AcceptSubmitClaim(context.Context, string, string, string, string, int64) (agentactivitybiz.SubmitClaim, bool, error)
	DeleteSubmitClaim(context.Context, string, string, string) (bool, error)
}

type AgentTargetStore interface {
	DeleteAgentTarget(context.Context, string) error
	GetAgentTarget(context.Context, string) (agenttargetbiz.Target, error)
	ListAgentTargets(context.Context) ([]agenttargetbiz.Target, error)
	PutAgentTarget(context.Context, agenttargetbiz.Target) (agenttargetbiz.Target, error)
}

type PreferencesStore interface {
	GetDesktopPreferences(context.Context) (preferencesbiz.DesktopPreferences, error)
	PutDesktopPreferences(context.Context, preferencesbiz.DesktopPreferences) (preferencesbiz.DesktopPreferences, error)
}

type ManagedCredentialsStore interface {
	DeleteManagedModelGrant(context.Context, string, string, string) error
	DeleteManagedModelProviderConfig(context.Context, string, managedcredentialsbiz.ProviderID) error
	GetManagedModelGrant(context.Context, string, string, string) (managedcredentialsbiz.Grant, error)
	GetManagedModelProviderConfig(context.Context, string, managedcredentialsbiz.ProviderID) (managedcredentialsbiz.ProviderConfig, error)
	ListManagedModelProviderConfigs(context.Context, string) ([]managedcredentialsbiz.ProviderConfig, error)
	PutManagedModelGrant(context.Context, managedcredentialsbiz.Grant) error
	PutManagedModelProviderConfig(context.Context, managedcredentialsbiz.ProviderConfig) error
	RevokeManagedModelGrant(context.Context, string, string, string) error
}

type UserProjectStore interface {
	DeleteUserProject(context.Context, string) error
	DeleteUserProjectByPath(context.Context, string) error
	ListUserProjects(context.Context) ([]userprojectbiz.Project, error)
	PutUserProject(context.Context, userprojectbiz.Project) (userprojectbiz.Project, error)
	TouchUserProject(context.Context, string, int64) error
}

type AppStore interface {
	DeleteAppPackage(context.Context, string) error
	DeleteAppPackageVersion(context.Context, string, string) error
	DeleteWorkspaceAppInstallation(context.Context, string, string) error
	GetAppPackage(context.Context, string) (workspacebiz.AppPackage, error)
	GetAppPackageVersion(context.Context, string, string) (workspacebiz.AppPackage, error)
	ListAppPackageFileRecords(context.Context, string) ([]workspacebiz.AppPackageFileRecord, error)
	ListAppPackageVersions(context.Context, string) ([]workspacebiz.AppPackage, error)
	ListAppPackages(context.Context) ([]workspacebiz.AppPackage, error)
	ListWorkspaceAppInstallationsByApp(context.Context, string) ([]workspacebiz.AppInstallation, error)
	ListWorkspaceAppInstallations(context.Context, string) ([]workspacebiz.AppInstallation, error)
	PutAppPackage(context.Context, workspacebiz.AppPackage) error
	PutAppPackageVersion(context.Context, workspacebiz.AppPackage) error
	SetActiveAppPackageVersion(context.Context, string, string) error
	PutWorkspaceAppInstallation(context.Context, workspacebiz.AppInstallation) error
}

type AppFactoryStore interface {
	DeleteAppFactoryJob(context.Context, string, string) error
	GetAppFactoryJob(context.Context, string, string) (workspacebiz.AppFactoryJob, error)
	ListAppFactoryJobs(context.Context, string) ([]workspacebiz.AppFactoryJob, error)
	PutAppFactoryJob(context.Context, workspacebiz.AppFactoryJob) error
}
