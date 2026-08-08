package workspaceissues

import "context"

type issueWithContextRefsStore interface {
	CreateIssueWithContextRefs(context.Context, Issue, []ContextRef) (Issue, []ContextRef, error)
}

// CreateIssueWithTasks validates and persists a new Issue and its initial task
// graph as one store operation. Callers never observe a partially created Plan
// Issue, and no compensating delete is required when a task insert fails.
func (s Service) CreateIssueWithTasks(ctx context.Context, input CreateIssueWithTasksInput) (Issue, []Task, error) {
	issue, tasks, err := s.PrepareIssueWithTasks(ctx, input)
	if err != nil {
		return Issue{}, nil, err
	}
	store, err := s.store()
	if err != nil {
		return Issue{}, nil, err
	}
	return store.CreateIssueWithTasks(ctx, issue, tasks)
}

// PrepareIssueWithTasks validates and normalizes a new Issue graph without
// persisting it. Product adapters use this when their owning transaction must
// atomically include additional durable state alongside the reusable Issue
// aggregate.
func (s Service) PrepareIssueWithTasks(ctx context.Context, input CreateIssueWithTasksInput) (Issue, []Task, error) {
	store, err := s.store()
	if err != nil {
		return Issue{}, nil, err
	}
	if len(input.Tasks) == 0 {
		return Issue{}, nil, ErrInvalidArgument
	}
	issue, err := s.buildIssue(ctx, store, input.Issue)
	if err != nil {
		return Issue{}, nil, err
	}
	tasks, err := s.buildTasks(issue, input.Issue.ActorUserID, input.Tasks)
	if err != nil {
		return Issue{}, nil, err
	}
	if !ValidateTaskDependencyGraph(tasks) {
		return Issue{}, nil, ErrInvalidArgument
	}
	issue.TaskCount = len(tasks)
	issue.NotStartedCount = len(tasks)
	if issue.Budget.Mode == BudgetModeAuto {
		issue.Budget.TokenLimit = CompileAutoTokenBudgetWithHistory(
			issue.TaskCount,
			issue.ExecutionProfile,
			input.Issue.AutoTokenBudgetHistoryHint,
		)
	}
	return issue, tasks, nil
}

// CreateIssueWithContextRefs persists a new Issue and its Issue-scoped context
// references in one store transaction. This is used for managed attachment
// files so a committed Issue can never be observed without its durable refs.
func (s Service) CreateIssueWithContextRefs(
	ctx context.Context,
	input CreateIssueWithContextRefsInput,
) (Issue, []ContextRef, error) {
	issue, refs, err := s.PrepareIssueWithContextRefs(ctx, input)
	if err != nil {
		return Issue{}, nil, err
	}
	store, err := s.store()
	if err != nil {
		return Issue{}, nil, err
	}
	atomicStore, ok := store.(issueWithContextRefsStore)
	if !ok {
		return Issue{}, nil, ErrStoreNotConfigured
	}
	return atomicStore.CreateIssueWithContextRefs(ctx, issue, refs)
}

// PrepareIssueWithContextRefs validates the Issue and its references without
// persistence, allowing a product-owned adapter to include extra durable state
// in the same transaction.
func (s Service) PrepareIssueWithContextRefs(
	ctx context.Context,
	input CreateIssueWithContextRefsInput,
) (Issue, []ContextRef, error) {
	store, err := s.store()
	if err != nil {
		return Issue{}, nil, err
	}
	if len(input.Refs) == 0 {
		return Issue{}, nil, ErrInvalidArgument
	}
	issue, err := s.buildIssue(ctx, store, input.Issue)
	if err != nil {
		return Issue{}, nil, err
	}
	refs, err := s.buildContextRefs(issue, "", ContextRefParentIssue, input.Refs)
	if err != nil {
		return Issue{}, nil, err
	}
	return issue, refs, nil
}
