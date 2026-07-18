package workspace

import (
	"context"
	"errors"
	"time"

	agentstore "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agentquickpromptbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentquickprompt"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	automationrulebiz "github.com/tutti-os/tutti/services/tuttid/biz/automationrule"
	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	managedcredentialsbiz "github.com/tutti-os/tutti/services/tuttid/biz/managedcredentials"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	activationbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeactivation"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	workflowbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceworkflow"
)

var ErrWorkspaceNotFound = errors.New("workspace not found")
var ErrWorkbenchSnapshotNotFound = errors.New("workspace workbench snapshot not found")
var ErrWorkspaceAppNotFound = errors.New("workspace app not found")
var ErrWorkspaceAppFactoryJobNotFound = errors.New("workspace app factory job not found")
var ErrUserProjectNotFound = errors.New("user project not found")
var ErrUserProjectPartitionMismatch = errors.New("user project move crosses pinned partition")
var ErrWorkspaceWorkflowNotFound = errors.New("workspace workflow not found")
var ErrWorkflowCheckpointNotFound = errors.New("workspace workflow checkpoint not found")
var ErrWorkflowOperationNotFound = errors.New("workspace workflow operation not found")
var ErrWorkflowRevisionConflict = errors.New("workspace workflow revision conflicts with durable history")
var ErrWorkflowMutationConflict = errors.New("workspace workflow mutation request conflicts with durable history")
var ErrTuttiModeActivationRevisionConflict = errors.New("tutti mode activation revision conflicts with durable state")

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
	GetSubmitClaim(context.Context, string, string, string) (agentactivitybiz.SubmitClaim, bool, error)
	AcceptSubmitClaim(context.Context, string, string, string, string, int64) (agentactivitybiz.SubmitClaim, bool, error)
	DeleteSubmitClaim(context.Context, string, string, string) (bool, error)
}

type AgentTargetStore interface {
	DeleteAgentTarget(context.Context, string) error
	GetAgentTarget(context.Context, string) (agenttargetbiz.Target, error)
	ListAgentTargets(context.Context) ([]agenttargetbiz.Target, error)
	PutAgentTarget(context.Context, agenttargetbiz.Target) (agenttargetbiz.Target, error)
}

type AgentQuickPromptStore interface {
	ListAgentQuickPrompts(context.Context) ([]agentquickpromptbiz.Prompt, error)
	CountAgentQuickPrompts(context.Context) (int, error)
	CreateAgentQuickPrompt(context.Context, agentquickpromptbiz.Prompt) error
	UpdateAgentQuickPrompt(context.Context, agentquickpromptbiz.Prompt, int64) (agentquickpromptbiz.Prompt, error)
	DeleteAgentQuickPrompt(context.Context, string, int64) error
	MoveAgentQuickPrompt(context.Context, string, *string, int64, int64) ([]agentquickpromptbiz.Prompt, bool, error)
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

type ModelPlanFirstUseStore interface {
	DeleteModelPlanFirstUseCandidate(context.Context, string, string) error
	GetModelPlanFirstUseCandidate(context.Context, string, string) (modelplanbiz.FirstUseCandidate, error)
	ListModelPlanFirstUseCandidates(context.Context) ([]modelplanbiz.FirstUseCandidate, error)
	PutModelPlanFirstUseCandidate(context.Context, modelplanbiz.FirstUseCandidate) error
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
	RecordAutomationRuleExecution(context.Context, automationrulebiz.Execution) error
	MarkAutomationRuleExecutionLaunchFailed(ctx context.Context, workspaceID string, targetSessionID string, failureReason string) error
	AutomationRuleExecutionExists(ctx context.Context, workspaceID string, sourceSessionID string, ruleID string, triggerID string) (bool, error)
	AutomationRuleUsage(ctx context.Context, workspaceID string, sourceSessionID string, ruleID string) (int, int64, error)
	RecordAutomationTargetUsage(ctx context.Context, workspaceID string, targetSessionID string, totalTokens int64) error
}

type CollaborationRunsStore interface {
	GetCollaborationRun(context.Context, string, string) (collabrunbiz.Run, error)
	ListCollaborationRuns(context.Context, string, string, int) ([]collabrunbiz.Run, error)
	PutCollaborationRun(context.Context, collabrunbiz.Run) error
}

// WorkspaceWorkflowsStore persists Tutti-owned workflow truth. Source agent
// session/turn/tool-call ids are provenance only and intentionally do not
// create cross-owner foreign keys into the provider activity store.
type WorkspaceWorkflowsStore interface {
	CreateWorkspaceWorkflowProposal(context.Context, workflowbiz.ProposalAggregate) error
	CreateWorkspaceWorkflowProposalWithMutation(context.Context, CreateWorkspaceWorkflowProposalMutationInput) (workflowbiz.WorkflowMutation, bool, error)
	GetWorkspaceWorkflowMutation(context.Context, GetWorkspaceWorkflowMutationInput) (workflowbiz.WorkflowMutation, bool, error)
	GetWorkspaceWorkflowSnapshot(context.Context, string, string) (workflowbiz.Snapshot, error)
	ListWorkflowsBySourceSession(context.Context, string, string) ([]workflowbiz.Workflow, error)
	ListPendingWorkflowCheckpointsBySourceSession(context.Context, string, string) ([]workflowbiz.PendingCheckpoint, error)
	AppendWorkspaceWorkflowPlanRevision(context.Context, AppendWorkspaceWorkflowPlanRevisionInput) error
	AppendWorkspaceWorkflowPlanRevisionWithMutation(context.Context, AppendWorkspaceWorkflowPlanRevisionMutationInput) (workflowbiz.WorkflowMutation, bool, error)
	AppendWorkspaceWorkflowTurnLink(context.Context, string, workflowbiz.WorkflowTurnLink) error
	DecideWorkspaceWorkflowCheckpoint(context.Context, DecideWorkspaceWorkflowCheckpointInput) (workflowbiz.WorkflowCheckpoint, bool, error)
	RecordWorkspaceWorkflowOperation(context.Context, string, workflowbiz.WorkflowOperation) error
	RetryWorkspaceWorkflowOperation(context.Context, RetryWorkspaceWorkflowOperationInput) (workflowbiz.WorkflowOperation, bool, error)
	CompleteWorkspaceWorkflowOperation(context.Context, CompleteWorkspaceWorkflowOperationInput) (workflowbiz.WorkflowOperation, bool, error)
	ListRecoverableCreateIssueOperations(context.Context) ([]RecoverableCreateIssueOperation, error)
}

type TuttiModeActivationsStore interface {
	GetTuttiModeActivation(context.Context, string, string) (activationbiz.Activation, bool, error)
	ListTuttiModeActivations(context.Context, string, []string) (map[string]activationbiz.Activation, error)
	SetTuttiModeActivation(context.Context, SetTuttiModeActivationInput) (activationbiz.Activation, bool, error)
	GetTuttiModeTurnSnapshot(context.Context, string, string, string) (activationbiz.TurnSnapshot, bool, error)
	PutTuttiModeTurnSnapshot(context.Context, string, string, string, activationbiz.TurnSnapshot, time.Time) (activationbiz.TurnSnapshot, bool, error)
	AcceptTuttiModeTurnSnapshot(context.Context, string, string, string, time.Time) (bool, error)
	IsTuttiModeTurnSnapshotAccepted(context.Context, string, string, string) (bool, error)
	AbandonTuttiModeTurnSnapshot(context.Context, string, string, string, activationbiz.TurnSnapshot) (bool, error)
	DeleteTuttiModeActivationSessionState(context.Context, string, string) error
}

type SetTuttiModeActivationInput struct {
	WorkspaceID      string
	AgentSessionID   string
	ActivationID     string
	RevisionID       string
	ExpectedRevision *int64
	State            activationbiz.State
	Source           activationbiz.Source
	// OrchestrationIntensity is optional. Nil keeps the current revision's
	// value, or the default planning strength for a first revision.
	OrchestrationIntensity *int
	ChangedAt              time.Time
}

type AppendWorkspaceWorkflowPlanRevisionInput struct {
	WorkspaceID               string
	WorkflowID                string
	ExpectedSourceSessionID   string
	ExpectedCurrentRevisionID string
	ExpectedWorkflowStatus    workflowbiz.WorkflowStatus
	ExpectedCheckpointID      string
	ExpectedCheckpointStatus  workflowbiz.CheckpointStatus
	Revision                  workflowbiz.PlanRevision
	Checkpoint                workflowbiz.WorkflowCheckpoint
	TurnLinks                 []workflowbiz.WorkflowTurnLink
	CompleteOperation         *AppendWorkspaceWorkflowOperationCompletion
	UpdatedAt                 time.Time
}

type CreateWorkspaceWorkflowProposalMutationInput struct {
	Aggregate workflowbiz.ProposalAggregate
	Mutation  workflowbiz.WorkflowMutation
}

type AppendWorkspaceWorkflowPlanRevisionMutationInput struct {
	Append   AppendWorkspaceWorkflowPlanRevisionInput
	Mutation workflowbiz.WorkflowMutation
}

type GetWorkspaceWorkflowMutationInput struct {
	WorkspaceID     string
	SourceSessionID string
	Kind            workflowbiz.MutationKind
	ScopeID         string
	RequestID       string
}

type RecoverableCreateIssueOperation struct {
	WorkspaceID     string
	SourceSessionID string
	Checkpoint      workflowbiz.WorkflowCheckpoint
	Operation       workflowbiz.WorkflowOperation
}

// PendingConfigurationReviewCheckpoint identifies one legacy two-phase
// workflow whose pending configuration review must be retired at startup.
type PendingConfigurationReviewCheckpoint struct {
	WorkspaceID  string
	WorkflowID   string
	CheckpointID string
}

// AppendWorkspaceWorkflowOperationCompletion closes the exact Agent follow-up
// operation whose output is the newly appended revision. The append and
// completion share one SQLite transaction so a revision cannot be committed
// while its deterministic generate/revise operation remains pending.
type AppendWorkspaceWorkflowOperationCompletion struct {
	OperationID    string
	Kind           workflowbiz.OperationKind
	RevisionID     string
	ExpectedStatus workflowbiz.OperationStatus
}

type DecideWorkspaceWorkflowCheckpointInput struct {
	WorkspaceID               string
	WorkflowID                string
	CheckpointID              string
	ExpectedStatus            workflowbiz.CheckpointStatus
	ExpectedCurrentRevisionID string
	ExpectedWorkflowStatus    workflowbiz.WorkflowStatus
	Decision                  workflowbiz.CheckpointStatus
	DecidedBy                 string
	DecisionReason            string
	// TaskAssignments records user-owned per-task overrides with the decision.
	TaskAssignments []workflowbiz.TaskAssignment
	DecidedAt       time.Time
	WorkflowStatus  workflowbiz.WorkflowStatus
	Operation       *workflowbiz.WorkflowOperation
}

type CompleteWorkspaceWorkflowOperationInput struct {
	WorkspaceID    string
	WorkflowID     string
	OperationID    string
	ExpectedStatus workflowbiz.OperationStatus
	Status         workflowbiz.OperationStatus
	IssueID        string
	ErrorCode      string
	ErrorMessage   string
	CompletedAt    time.Time
}

type RetryWorkspaceWorkflowOperationInput struct {
	WorkspaceID string
	WorkflowID  string
	OperationID string
	RetriedAt   time.Time
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
