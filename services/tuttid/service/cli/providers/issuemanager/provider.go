package issuemanager

import (
	"context"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/providers/refresolve"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

const (
	appID             = "issue-manager"
	appName           = "Task Manager"
	appCLIDescription = "Manage workspace tasks and runs."
	appDescription    = "Plan, track, and execute workspace task work."
)

type IssueManager interface {
	ListTopics(context.Context, string) (workspaceissues.TopicList, error)
	CreateTopic(context.Context, string, workspaceservice.CreateIssueManagerTopicInput) (workspaceissues.Topic, error)
	UpdateTopic(context.Context, string, string, workspaceservice.UpdateIssueManagerTopicInput) (workspaceissues.Topic, error)
	DeleteTopic(context.Context, string, string) (bool, error)
	ListIssues(context.Context, string, workspaceservice.ListIssueManagerItemsInput) (workspaceissues.IssueList, error)
	CreateIssue(context.Context, string, workspaceservice.CreateIssueManagerIssueInput) (workspaceissues.Issue, error)
	GetIssueDetail(context.Context, string, string) (workspaceissues.IssueDetail, error)
	UpdateIssue(context.Context, string, string, workspaceservice.UpdateIssueManagerIssueInput) (workspaceissues.Issue, error)
	DeleteIssue(context.Context, string, string) (bool, error)
	ListTasks(context.Context, string, string, workspaceservice.ListIssueManagerItemsInput) (workspaceissues.TaskList, error)
	CreateTask(context.Context, string, string, workspaceservice.CreateIssueManagerTaskInput) (workspaceissues.Task, error)
	CreateTasks(context.Context, string, string, workspaceservice.CreateIssueManagerTasksInput) ([]workspaceissues.Task, error)
	GetTaskDetail(context.Context, string, string, string) (workspaceissues.TaskDetail, error)
	UpdateTask(context.Context, string, string, string, workspaceservice.UpdateIssueManagerTaskInput) (workspaceissues.Task, error)
	DeleteTask(context.Context, string, string, string) (bool, error)
	ListRuns(context.Context, string, string, string) ([]workspaceissues.Run, error)
	CreateRun(context.Context, string, string, string, workspaceservice.CreateIssueManagerRunInput) (workspaceissues.Run, error)
	GetRunDetail(context.Context, string, string, string, string) (workspaceissues.RunDetail, error)
	CompleteRun(context.Context, string, string, string, string, workspaceservice.CompleteIssueManagerRunInput) (workspaceissues.RunDetail, error)
	// SearchIssueOutputs backs inline expansion of whole-topic workspace-reference handles.
	SearchIssueOutputs(context.Context, workspaceissues.RunOutputSearchParams) ([]workspaceissues.RunOutputSearchHit, error)
}

type Provider struct {
	workspaces cliservice.WorkspaceCatalog
	issues     IssueManager
	apps       refresolve.AppReferences
}

func NewProvider(workspaces cliservice.WorkspaceCatalog, issues IssueManager, apps refresolve.AppReferences) Provider {
	return Provider{workspaces: workspaces, issues: issues, apps: apps}
}

// referenceResolver expands embedded workspace-reference handles found in issue/task content.
func (p Provider) referenceResolver() refresolve.Resolver {
	return refresolve.Resolver{Apps: p.apps, Issues: p.issues}
}

func (Provider) AppID() string {
	return appID
}

func (p Provider) Commands() []cliservice.Command {
	commands := []cliservice.Command{
		p.newTopicListCommand(),
		p.newTopicCreateCommand(),
		p.newTopicUpdateCommand(),
		p.newTopicDeleteCommand(),
		p.newIssueListCommand(),
		p.newIssueGetCommand(),
		p.newIssueCreateCommand(),
		p.newIssueUpdateCommand(),
		p.newIssueDeleteCommand(),
		p.newTaskListCommand(),
		p.newTaskGetCommand(),
		p.newTaskCreateCommand(),
		p.newTaskCreateBatchCommand(),
		p.newTaskUpdateCommand(),
		p.newTaskDeleteCommand(),
		p.newIssueRunCreateCommand(),
		p.newIssueRunCompleteCommand(),
		p.newRunListCommand(),
		p.newRunGetCommand(),
		p.newRunCreateCommand(),
		p.newRunCompleteCommand(),
	}
	for i := range commands {
		commands[i] = issueManagerAppCommand(commands[i])
	}
	return commands
}

func issueManagerAppCommand(command cliservice.Command) cliservice.Command {
	command.Capability.Source = cliservice.CapabilitySource{
		Kind:           cliservice.CapabilitySourceApp,
		AppID:          appID,
		AppName:        appName,
		CLIDescription: appCLIDescription,
		AppDescription: appDescription,
	}
	return command
}

func (p Provider) requireIssueManager() error {
	if p.issues == nil {
		return workspaceissues.ErrInvalidArgument
	}
	return nil
}
