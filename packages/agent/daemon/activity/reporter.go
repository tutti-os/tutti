package agentsessionstore

import "context"

type ActivityReporter interface {
	Report(ctx context.Context, input ReportActivityInput) error
}

type SessionActivityReporter interface {
	ReportSessionState(context.Context, ReportSessionStateInput) (ReportSessionStateReply, error)
	ReportSessionMessages(context.Context, ReportSessionMessagesInput) (ReportSessionMessagesReply, error)
}

// GoalReconcileRequestReporter is an internal control-plane extension. Unlike
// session audits it never persists in or hydrates from the transcript.
type GoalReconcileRequestReporter interface {
	ReportGoalReconcileRequired(context.Context, ReportGoalReconcileRequiredInput) (ReportGoalReconcileRequiredReply, error)
}

// GoalProvenanceLedger is deliberately synchronous: a provider adapter must
// fail closed when durable provenance cannot be bound or resolved.
type GoalProvenanceLedger interface {
	BindGoalProvenance(context.Context, BindGoalProvenanceInput) (GoalProvenanceBinding, error)
	LookupGoalProvenance(context.Context, LookupGoalProvenanceInput) (GoalProvenanceBinding, bool, error)
}
