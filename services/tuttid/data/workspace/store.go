package workspace

import (
	"context"
	"errors"

	agentstore "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	managedcredentialsbiz "github.com/tutti-os/tutti/services/tuttid/biz/managedcredentials"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
)

var ErrWorkspaceNotFound = errors.New("workspace not found")
var ErrWorkbenchSnapshotNotFound = errors.New("workspace workbench snapshot not found")
var ErrWorkspaceAppNotFound = errors.New("workspace app not found")
var ErrWorkspaceAppFactoryJobNotFound = errors.New("workspace app factory job not found")
var ErrUserProjectNotFound = errors.New("user project not found")
var ErrUserProjectPartitionMismatch = errors.New("user project move crosses pinned partition")

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
	agentactivitybiz.SessionTurnSummaryReader
	CheckpointRuntimeOperation(context.Context, agentactivitybiz.CheckpointRuntimeOperationInput) (agentactivitybiz.RuntimeOperation, bool, error)
	CompletePlanDecisionRuntimeOperation(context.Context, agentactivitybiz.CompletePlanDecisionRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error)
	FindTurnByClientSubmitID(context.Context, string, string, string) (string, bool, error)
	PrepareGoalControlOperation(context.Context, agentactivitybiz.GoalControlOperationPrepare) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error)
	GetGoalControlAudit(context.Context, string, string, string) (agentactivitybiz.Message, bool, error)
	MarkGoalControlOperationDispatched(context.Context, string, string, int64) (agentactivitybiz.GoalControlOperation, bool, error)
	AcknowledgeGoalControlOperation(context.Context, agentactivitybiz.GoalControlOperationAcknowledge) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error)
	CompleteGoalControlOperation(context.Context, agentactivitybiz.GoalControlOperationComplete) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error)
	GetSessionGoalState(context.Context, string, string) (agentactivitybiz.SessionGoalState, bool, error)
	ReconcileSessionGoalObservation(context.Context, agentactivitybiz.GoalObservationReconcile) (agentactivitybiz.SessionGoalState, error)
	MarkGoalRevisionTerminalIncident(context.Context, agentactivitybiz.GoalTerminalIncidentInput) (agentactivitybiz.SessionGoalState, error)
	GetGoalControlOperation(context.Context, string, string) (agentactivitybiz.GoalControlOperation, bool, error)
	ListClaimableGoalControlOperations(context.Context, agentactivitybiz.ListClaimableGoalControlOperationsInput) ([]agentactivitybiz.GoalControlOperation, error)
	ClaimGoalControlOperation(context.Context, agentactivitybiz.ClaimGoalControlOperationInput) (agentactivitybiz.GoalControlOperation, bool, error)
	ReleaseGoalControlOperation(context.Context, agentactivitybiz.ReleaseGoalControlOperationInput) (agentactivitybiz.GoalControlOperation, bool, error)
	RecordGoalControlOperationEvidence(context.Context, agentactivitybiz.GoalControlOperationEvidence) (agentactivitybiz.GoalControlOperation, bool, error)
	EnsureOrWakeGoalRepairOperation(context.Context, agentactivitybiz.EnsureGoalRepairOperationInput) (agentactivitybiz.GoalControlOperation, agentactivitybiz.SessionGoalState, bool, error)
	RequeueLeasedGoalControlOperationsOnStartup(context.Context, int64) (int64, error)
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

type AgentComposerDefaultsPatchStore interface {
	PatchAgentComposerDefaultsForTarget(context.Context, string, preferencesbiz.AgentComposerDefaultsPatch) (preferencesbiz.AgentComposerDefaults, error)
}

type ModelPlansStore interface {
	DeleteModelPlan(context.Context, string, string) error
	GetModelPlan(context.Context, string, string) (modelplanbiz.Plan, error)
	ListModelPlans(context.Context, string) ([]modelplanbiz.Plan, error)
	PutModelPlan(context.Context, modelplanbiz.Plan) error
}

type AgentModelBindingsStore interface {
	DeleteAgentModelBinding(context.Context, string, string) error
	GetAgentModelBinding(context.Context, string, string) (modelbindingbiz.Binding, error)
	ListAgentModelBindings(context.Context, string) ([]modelbindingbiz.Binding, error)
	ListAgentModelBindingsByPlan(context.Context, string, string) ([]modelbindingbiz.Binding, error)
	PutAgentModelBinding(context.Context, modelbindingbiz.Binding) error
}

type WorkspaceAgentsStore interface {
	DeleteWorkspaceAgent(context.Context, string, string) error
	GetWorkspaceAgent(context.Context, string, string) (workspaceagentbiz.Agent, error)
	ListWorkspaceAgents(context.Context, string) ([]workspaceagentbiz.Agent, error)
	ListWorkspaceAgentsByModelPlan(context.Context, string, string) ([]workspaceagentbiz.Agent, error)
	PutWorkspaceAgent(context.Context, workspaceagentbiz.Agent) error
}

type AutomationRulesStore interface {
	DeleteAutomationRule(context.Context, string, string) error
	GetAutomationRule(context.Context, string, string) (automationrulebiz.Rule, error)
	ListAutomationRules(context.Context, string) ([]automationrulebiz.Rule, error)
	ListAutomationRulesByPlan(context.Context, string, string) ([]automationrulebiz.Rule, error)
	CreateAutomationRule(context.Context, automationrulebiz.Rule) error
	UpdateAutomationRule(context.Context, automationrulebiz.Rule) (automationrulebiz.Rule, error)
	GetAutomationRuleSessionOverride(context.Context, string, string) (automationrulebiz.SessionOverride, bool, error)
	PutAutomationRuleSessionOverride(context.Context, automationrulebiz.SessionOverride) error
}

type CollaborationRunsStore interface {
	GetCollaborationRun(context.Context, string, string) (collabrunbiz.Run, error)
	ListCollaborationRuns(context.Context, string, string, int) ([]collabrunbiz.Run, error)
	PutCollaborationRun(context.Context, collabrunbiz.Run) error
}

// IssueCollaborationUsageLink is the durable Issue association resolved from
// collaboration source/target sessions. DuplicateTaskRun means the
// CollaborationRun mirrors the same target session already recorded as an
// Issue Run and must not be counted twice.
type IssueCollaborationUsageLink struct {
	IssueID          string
	TaskID           string
	DuplicateTaskRun bool
}

type IssueCollaborationUsageTotals struct {
	Usage collabrunbiz.Usage
	Cost  collabrunbiz.Cost
}

// IssueCollaborationUsageStore is an optional Issue accounting extension.
// The SQLite host implements it atomically; generic workspace Issue stores do
// not have to expose collaboration persistence.
type IssueCollaborationUsageStore interface {
	ResolveIssueCollaborationUsageLink(context.Context, collabrunbiz.Run) (IssueCollaborationUsageLink, bool, error)
	RecordIssueCollaborationUsage(context.Context, IssueCollaborationUsageLink, collabrunbiz.Run) (bool, error)
	GetIssueCollaborationUsageTotals(context.Context, string, string, string) (IssueCollaborationUsageTotals, error)
}

type ManagedCredentialsStore interface {
	DeleteManagedModelGrant(context.Context, string, string, string) error
	DeleteManagedModelProviderConfig(context.Context, string, managedcredentialsbiz.ProviderID) error
	GetManagedModelGrant(context.Context, string, string, string) (managedcredentialsbiz.Grant, error)
	GetManagedModelProviderConfig(context.Context, string, managedcredentialsbiz.ProviderID) (managedcredentialsbiz.ProviderConfig, error)
	ListManagedModelGrants(context.Context, string) ([]managedcredentialsbiz.Grant, error)
	ListManagedModelProviderConfigs(context.Context, string) ([]managedcredentialsbiz.ProviderConfig, error)
	PutManagedModelGrant(context.Context, managedcredentialsbiz.Grant) error
	PutManagedModelProviderConfig(context.Context, managedcredentialsbiz.ProviderConfig) error
	RevokeManagedModelGrant(context.Context, string, string, string) error
}

type UserProjectStore interface {
	DeleteUserProject(context.Context, string) error
	DeleteUserProjectByPath(context.Context, string) error
	ListUserProjects(context.Context) ([]userprojectbiz.Project, error)
	MoveUserProject(context.Context, string, *string) ([]userprojectbiz.Project, error)
	PinUserProject(context.Context, string, bool) ([]userprojectbiz.Project, bool, error)
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
