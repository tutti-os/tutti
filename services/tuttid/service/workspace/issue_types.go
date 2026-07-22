package workspace

import (
	"context"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

// IssueAssignmentAgentTargetReader resolves a task's assigned agent target at
// dispatch time.
type IssueAssignmentAgentTargetReader interface {
	GetAgentTarget(context.Context, string) (agenttargetbiz.Target, error)
}

type ListIssueManagerItemsInput struct {
	PageSize     int
	PageToken    string
	TopicID      string
	StatusFilter string
	SearchQuery  string
}

type CreateIssueManagerIssueInput struct {
	IssueID             string
	TopicID             string
	Title               string
	Content             string
	PlanningSource      string
	SourceSessionID     string
	SequentialExecution bool
	ParallelExecution   bool
	ExecutionProfile    workspaceissues.ExecutionProfile
	HasExecutionProfile bool
	Budget              workspaceissues.Budget
	HasBudget           bool
	// TuttiModeWorkflowOwned is an internal authority marker. Transport and
	// generic CLI adapters never set it; only the accepted workflow materializer
	// may create an Issue in the reserved deterministic namespace.
	TuttiModeWorkflowOwned bool
}

type CreateIssueManagerIssueFromPlanInput struct {
	Issue CreateIssueManagerIssueInput
	Tasks []CreateIssueManagerTaskItemInput
}

type EstimateIssueManagerAutoTokenBudgetInput struct {
	ExecutionProfile workspaceissues.ExecutionProfile
	Tasks            []CreateIssueManagerTaskItemInput
}

type IssueManagerAutoTokenBudgetEstimate struct {
	TokenLimit                 int64
	DeterministicTokenLimit    int64
	HistoricalTokenEstimate    int64
	MatchedHistoricalTaskCount int
}

type CreateIssueManagerTopicInput struct {
	TopicID string
	Title   string
	Summary string
}

type UpdateIssueManagerTopicInput struct {
	Title      string
	HasTitle   bool
	Summary    string
	HasSummary bool
	Pinned     bool
	HasPinned  bool
}

type UpdateIssueManagerIssueInput struct {
	Title               string
	HasTitle            bool
	Content             string
	HasContent          bool
	Status              string
	HasStatus           bool
	DispatchPaused      bool
	HasDispatchPaused   bool
	ExecutionProfile    workspaceissues.ExecutionProfile
	HasExecutionProfile bool
	Budget              workspaceissues.Budget
	HasBudget           bool
}

type CreateIssueManagerTaskInput struct {
	TaskID             string
	Title              string
	Content            string
	Priority           string
	DueAtUnixMS        int64
	AgentTargetID      string
	ModelPlanID        string
	Model              string
	PermissionModeID   string
	ReasoningEffort    string
	ExecutionDirectory string
	DependencyTaskIDs  []string
	Parallelizable     bool
	AutoAccept         bool
}

type CreateIssueManagerTaskItemInput struct {
	TaskID             string
	Title              string
	Content            string
	Priority           string
	DueAtUnixMS        int64
	AgentTargetID      string
	ModelPlanID        string
	Model              string
	PermissionModeID   string
	ReasoningEffort    string
	ExecutionDirectory string
	DependencyTaskIDs  []string
	Parallelizable     bool
	AutoAccept         bool
}

type CreateIssueManagerTasksInput struct {
	Tasks []CreateIssueManagerTaskItemInput
}

type UpdateIssueManagerTaskInput struct {
	Title                 string
	HasTitle              bool
	Content               string
	HasContent            bool
	Status                string
	HasStatus             bool
	Priority              string
	HasPriority           bool
	DueAtUnixMS           int64
	HasDueAt              bool
	SortIndex             int
	HasSortIndex          bool
	AgentTargetID         string
	HasAgentTargetID      bool
	ModelPlanID           string
	HasModelPlanID        bool
	Model                 string
	HasModel              bool
	ExecutionDirectory    string
	HasExecutionDirectory bool
	DependencyTaskIDs     []string
	HasDependencyTaskIDs  bool
	Parallelizable        bool
	HasParallelizable     bool
	AutoAccept            bool
	HasAutoAccept         bool
	AcceptanceState       string
	HasAcceptanceState    bool
	AcceptanceSummary     string
	HasAcceptanceSummary  bool
}

type AddIssueManagerContextRefsInput struct {
	Refs []workspaceissues.AddContextRefInput
}

type CreateIssueManagerRunInput struct {
	RunID              string
	AgentTargetID      string
	AgentProvider      string
	AgentUserID        string
	AgentSessionID     string
	ExecutionDirectory string
	ModelPlanID        string
	Model              string
}

type CompleteIssueManagerRunInput struct {
	Status                   string
	Summary                  string
	ErrorMessage             string
	Outputs                  []workspaceissues.CompleteRunOutputInput
	Usage                    workspaceissues.TokenUsage
	Cost                     workspaceissues.Cost
	RemainingQuotaPercent    float64
	HasRemainingQuotaPercent bool
}
