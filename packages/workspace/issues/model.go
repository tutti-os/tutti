package workspaceissues

type Status string

const (
	StatusNotStarted        Status = "not_started"
	StatusRunning           Status = "running"
	StatusPendingAcceptance Status = "pending_acceptance"
	StatusCompleted         Status = "completed"
	StatusFailed            Status = "failed"
	StatusCanceled          Status = "canceled"
)

type Priority string

const (
	PriorityHigh   Priority = "high"
	PriorityMedium Priority = "medium"
	PriorityLow    Priority = "low"
)

type PlanningSource string

const (
	PlanningSourceManual          PlanningSource = "manual"
	PlanningSourceTuttiModePlan   PlanningSource = "tutti_mode_plan"
	PlanningSourceTraditionalPlan PlanningSource = "traditional_plan"
)

type BudgetMode string

const (
	BudgetModeAuto  BudgetMode = "auto"
	BudgetModeFixed BudgetMode = "fixed"
)

type BudgetStatus string

const (
	BudgetStatusActive      BudgetStatus = "active"
	BudgetStatusSoftLimited BudgetStatus = "soft_limited"
)

type ExecutionProfile struct {
	ReasoningIntensity     int
	OrchestrationIntensity int
}

type Budget struct {
	Mode                  BudgetMode
	TokenLimit            int64
	ConsumedTokens        int64
	QuotaWaterlinePercent float64
	RemainingQuotaPercent float64
	HasRemainingQuota     bool
	Status                BudgetStatus
}

type ContextRefParentKind string

const (
	ContextRefParentIssue ContextRefParentKind = "issue"
	ContextRefParentTask  ContextRefParentKind = "task"
)

const DefaultTopicID = "default"

type Topic struct {
	ID                   uint64
	TopicID              string
	WorkspaceID          string
	Title                string
	Summary              string
	IsDefault            bool
	PinnedAtUnixMS       int64
	LastActivityAtUnixMS int64
	CreatedAtUnixMS      int64
	UpdatedAtUnixMS      int64
}

type Issue struct {
	ID                     uint64
	IssueID                string
	TopicID                string
	WorkspaceID            string
	Title                  string
	Content                string
	SearchText             string
	Status                 Status
	TaskCount              int
	NotStartedCount        int
	RunningCount           int
	PendingAcceptanceCount int
	CompletedCount         int
	FailedCount            int
	CanceledCount          int
	CreatorUserID          string
	CreatorDisplayName     string
	CreatorAvatarURL       string
	PlanningSource         PlanningSource
	SourceSessionID        string
	SequentialExecution    bool
	ParallelExecution      bool
	ExecutionProfile       ExecutionProfile
	Budget                 Budget
	CreatedAtUnixMS        int64
	UpdatedAtUnixMS        int64
}

type Task struct {
	ID                 uint64
	TaskID             string
	IssueID            string
	WorkspaceID        string
	Title              string
	Content            string
	SearchText         string
	Status             Status
	Priority           Priority
	SortIndex          int
	DueAtUnixMS        int64
	CreatorUserID      string
	CreatorDisplayName string
	CreatorAvatarURL   string
	LatestRunID        string
	AgentTargetID      string
	ModelPlanID        string
	Model              string
	ExecutionDirectory string
	DependencyTaskIDs  []string
	CreatedAtUnixMS    int64
	UpdatedAtUnixMS    int64
}

type Run struct {
	ID                 uint64
	RunID              string
	TaskID             string
	IssueID            string
	WorkspaceID        string
	RequesterUserID    string
	AgentUserID        string
	AgentTargetID      string
	AgentSessionID     string
	AgentProvider      string
	Status             Status
	Summary            string
	ErrorMessage       string
	OutputDir          string
	ExecutionDirectory string
	CreatedAtUnixMS    int64
	StartedAtUnixMS    int64
	CompletedAtUnixMS  int64
	UpdatedAtUnixMS    int64
}

type RunOutput struct {
	ID              uint64
	OutputID        string
	RunID           string
	TaskID          string
	IssueID         string
	WorkspaceID     string
	Path            string
	DisplayName     string
	MediaType       string
	SizeBytes       int64
	CreatedAtUnixMS int64
}

// RunOutputSearchParams scopes a workspace-wide search over produced output files.
// Query matches output file display names. IssueID and TopicID are optional
// scopes; IssueID takes precedence when both are set.
type RunOutputSearchParams struct {
	WorkspaceID string
	Query       string
	// Filters 为已选「文件类型筛选分类」id(全局统一口径)。筛选与搜索是同一能力:
	// Query 可空、Filters 非空时即按类型查。空 = 不按类型过滤。
	Filters []string
	IssueID string
	TopicID string
	Limit   int
}

// RunOutputSearchHit is one matched output file annotated with its owning issue
// title, used as the search-result subtitle.
type RunOutputSearchHit struct {
	Output     RunOutput
	IssueTitle string
}

type ContextRef struct {
	ID              uint64
	ContextRefID    string
	WorkspaceID     string
	IssueID         string
	TaskID          string
	ParentKind      ContextRefParentKind
	RefType         string
	Path            string
	DisplayName     string
	CreatedAtUnixMS int64
}

type StatusCounts struct {
	All               int
	NotStarted        int
	Running           int
	PendingAcceptance int
	Completed         int
	Failed            int
	Canceled          int
}

type IssueListCursor struct {
	UpdatedAtUnixMS int64
	ID              uint64
}

type IssueListFilter struct {
	WorkspaceID  string
	TopicID      string
	PageSize     int
	Cursor       *IssueListCursor
	StatusFilter Status
	SearchQuery  string
	ReturnAll    bool
}

type IssueList struct {
	Items         []Issue
	NextCursor    *IssueListCursor
	NextPageToken string
	TotalCount    int
	StatusCounts  StatusCounts
}

type TopicList struct {
	Items []Topic
}

type TaskListCursor struct {
	SortIndex int
	ID        uint64
}

type TaskListFilter struct {
	WorkspaceID  string
	IssueID      string
	PageSize     int
	Cursor       *TaskListCursor
	StatusFilter Status
	SearchQuery  string
	ReturnAll    bool
}

type TaskList struct {
	Items         []Task
	NextCursor    *TaskListCursor
	NextPageToken string
	TotalCount    int
	StatusCounts  StatusCounts
}

type IssueDetail struct {
	Issue         Issue
	Tasks         []Task
	ContextRefs   []ContextRef
	LatestRun     *Run
	RecentRuns    []Run
	LatestOutputs []RunOutput
}

type TaskDetail struct {
	Task          Task
	ContextRefs   []ContextRef
	LatestRun     *Run
	RecentRuns    []Run
	LatestOutputs []RunOutput
}

type RunDetail struct {
	Run     Run
	Outputs []RunOutput
}
