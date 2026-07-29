package workspaceissues

import "context"

type Store interface {
	ListTopics(context.Context, string) (TopicList, error)
	CreateTopic(context.Context, Topic) (Topic, error)
	GetTopic(context.Context, string, string) (Topic, error)
	UpdateTopic(context.Context, Topic) (Topic, error)
	DeleteTopic(context.Context, string, string) (bool, error)
	TouchTopicActivity(context.Context, string, string, int64) error

	ListIssues(context.Context, IssueListFilter) (IssueList, error)
	CreateIssue(context.Context, Issue) (Issue, error)
	CreateIssueWithTasks(context.Context, Issue, []Task) (Issue, []Task, error)
	GetIssue(context.Context, string, string) (Issue, error)
	UpdateIssue(context.Context, Issue) (Issue, error)
	DeleteIssue(context.Context, string, string, string) (bool, error)
	RecalculateIssueProjection(context.Context, string, string) (Issue, error)

	ListTasks(context.Context, TaskListFilter) (TaskList, error)
	AppendTasks(context.Context, []Task) ([]Task, error)
	GetTask(context.Context, string, string, string) (Task, error)
	UpdateTask(context.Context, Task) (Task, error)
	DeleteTask(context.Context, string, string, string, string) (bool, error)

	AddContextRefs(context.Context, []ContextRef) ([]ContextRef, error)
	ListContextRefs(context.Context, string, string, string, ContextRefParentKind) ([]ContextRef, error)
	RemoveContextRef(context.Context, string, string, string, ContextRefParentKind, string) (bool, error)

	CreateRun(context.Context, Run) (Run, error)
	CompleteRun(context.Context, Run, []RunOutput) (Run, []RunOutput, error)
	// ListRuns returns runs scoped to workspace. An empty issueID intentionally
	// returns workspace history, which session-linkage lookups use without
	// adding a second persistence API. taskID is only meaningful when issueID
	// is set.
	ListRuns(context.Context, string, string, string) ([]Run, error)
	ListRunningRuns(context.Context, string, int) ([]Run, error)
	GetRun(context.Context, string, string, string, string) (Run, error)
	ListRunOutputs(context.Context, string, string, string, string) ([]RunOutput, error)
	ListLatestRunOutputs(context.Context, string, string, string) ([]RunOutput, error)
	SearchRunOutputs(context.Context, RunOutputSearchParams) ([]RunOutputSearchHit, error)
}
