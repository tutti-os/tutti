package workspace

import (
	"context"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

// IssueRunLauncher is the execution-side port of Issue dispatch. Issue Manager
// owns which task may run and durably claims the Run; the adapter owns creating
// the Agent session after the Issue mutation lock has been released.
type IssueRunLauncher interface {
	Launch(context.Context, IssueRunLaunch) error
}

type IssueRunLaunch struct {
	WorkspaceID        string
	AgentSessionID     string
	AgentTargetID      string
	RunID              string
	TaskID             string
	IssueID            string
	Title              string
	Prompt             string
	ExecutionDirectory string
	ModelPlanID        string
	Model              string
	ReasoningIntensity int
	ReasoningEffort    string
	PermissionModeID   string
	WorktreeBase       string
	WorktreeBranch     string
}

// IssueSourceSessionDirectoryResolver is the narrow read needed to inherit
// the planning session's working directory. Agent session lifecycle and
// projection details stay outside Issue Manager.
type IssueSourceSessionDirectoryResolver interface {
	ResolveSourceSessionDirectory(workspaceID string, agentSessionID string) (string, bool)
}

type IssueRunCancelState string

const (
	// IssueRunCancelAccepted means Agent Host accepted the cancellation
	// request; exact Turn settlement remains authoritative.
	IssueRunCancelAccepted IssueRunCancelState = "accepted"
	// IssueRunCancelCanceled means the adapter has authoritative evidence that
	// the exact initiating Turn settled canceled.
	IssueRunCancelCanceled IssueRunCancelState = "canceled"
	IssueRunCancelNotFound IssueRunCancelState = "not_found"
	IssueRunCancelSettled  IssueRunCancelState = "settled"
)

type IssueRunCancelResult struct {
	State      IssueRunCancelState
	Settlement *IssueRunSettlement
}

type IssueRunCancellationRequest struct {
	WorkspaceID    string
	AgentSessionID string
	RunID          string
}

// IssueRunSessionCanceller requests cancellation of one Run's delegate
// session and explicitly distinguishes accepted intent from canonical outcome.
type IssueRunSessionCanceller interface {
	RequestRunCancellation(ctx context.Context, request IssueRunCancellationRequest) (IssueRunCancelResult, error)
}

// IssueRunSettlement is the typed fact the coordinator consumes. Agent
// projection details are translated at the coordinator adapter boundary.
type IssueRunSettlement struct {
	WorkspaceID              string
	AgentSessionID           string
	TurnID                   string
	Status                   workspaceissues.Status
	ErrorMessage             string
	Usage                    workspaceissues.TokenUsage
	RemainingQuotaPercent    float64
	HasRemainingQuotaPercent bool
}

// IssueRunSettlementReader resolves the Run's initiating submit to its exact
// canonical Turn and returns a terminal fact only after that Turn settled.
type IssueRunSettlementReader interface {
	ReadRunSettlement(ctx context.Context, workspaceID string, agentSessionID string, clientSubmitID string) (IssueRunSettlement, bool, error)
}

type IssueRunReconciler interface {
	ReconcileRunningRuns(context.Context, string) (IssueRunReconcileResult, error)
}
