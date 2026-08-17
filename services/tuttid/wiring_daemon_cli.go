package main

import (
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
	agenttargetservice "github.com/tutti-os/tutti/services/tuttid/service/agenttarget"
	browsersvc "github.com/tutti-os/tutti/services/tuttid/service/browser"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	appclicli "github.com/tutti-os/tutti/services/tuttid/service/cli/appcli"
	agentcontextcli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/agentcontext"
	browsercli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/browser"
	computercli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/computer"
	diagnosticscli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/diagnostics"
	issuemanagercli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/issuemanager"
	managedmodelscli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/managedmodels"
	referencescli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/references"
	tuttigoalreviewcli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/tuttigoalreview"
	tuttimodeplancli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/tuttimodeplan"
	workbenchappscli "github.com/tutti-os/tutti/services/tuttid/service/cli/providers/workbenchapps"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	managedcredentialsservice "github.com/tutti-os/tutti/services/tuttid/service/managedcredentials"
	preferencesservice "github.com/tutti-os/tutti/services/tuttid/service/preferences"
	tuttimodeactivationservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeactivation"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type daemonCLIRegistryInput struct {
	Workspaces           workspaceservice.CatalogService
	Issues               *workspaceservice.IssueManagerService
	Apps                 *workspaceservice.AppCenterService
	Events               *eventstreamservice.Service
	ManagedCredentials   *managedcredentialsservice.Service
	AgentSessions        *agentservice.Service
	AgentTargets         agenttargetservice.Service
	AgentTargetSetup     *agentextensionservice.SetupService
	Preferences          *preferencesservice.Service
	TuttiModePlans       *tuttimodeplanservice.Service
	TuttiModeExecutions  *tuttimodeexecutionservice.Service
	TuttiModeActivations *tuttimodeactivationservice.Service
	Browser              *browsersvc.Service
	Computer             *computersvc.Service
	AppCommands          *appclicli.Registry
}

func buildDaemonCLIRegistry(
	input daemonCLIRegistryInput,
) (*cliservice.Registry, error) {
	providers := []cliservice.Provider{
		diagnosticscli.NewProvider(),
		managedmodelscli.NewProvider(input.ManagedCredentials),
		issuemanagercli.NewProvider(input.Workspaces, input.Issues, input.Apps),
		referencescli.NewProvider(input.Workspaces, input.Apps, input.Issues),
		workbenchappscli.NewProvider(
			input.Workspaces,
			input.Apps,
			eventstreamservice.WorkbenchNodeLaunchPublisher{
				Service: input.Events,
			},
		),
		agentcontextcli.NewProviderWithAgentTargets(
			input.Workspaces,
			input.AgentSessions,
			eventstreamservice.AgentGUILaunchPublisher{
				Service: input.Events,
			},
			input.AgentTargets,
			input.Preferences,
		).WithAgentTargetSetup(input.AgentTargetSetup),
		tuttimodeplancli.NewProviderWithExecutionSnapshot(
			input.Workspaces,
			input.TuttiModePlans,
			input.AgentSessions,
			input.Issues,
			input.Issues,
			input.TuttiModeExecutions,
			input.Issues,
			input.TuttiModeExecutions,
			input.TuttiModeExecutions,
		).WithTuttiModeActivations(input.TuttiModeActivations),
		tuttigoalreviewcli.NewProvider(
			input.TuttiModeExecutions,
			input.AgentSessions,
		),
	}
	if input.Browser != nil {
		providers = append(
			providers,
			browsercli.NewProvider(input.Workspaces, input.Browser, input.AgentSessions),
		)
	}
	if input.Computer != nil {
		providers = append(
			providers,
			computercli.NewProvider(input.Workspaces, input.Computer),
		)
	}
	registry, err := cliservice.NewRegistryFromProviders(providers...)
	if err != nil {
		return nil, err
	}
	registry.AgentSessionCapabilities = agentSessionCLIProjectionResolver{
		Sessions: input.AgentSessions,
	}
	registry.AppCommands = input.AppCommands
	return registry, nil
}
