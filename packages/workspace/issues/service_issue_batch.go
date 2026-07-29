package workspaceissues

import "context"

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
