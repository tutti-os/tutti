package api

import (
	"context"
	"net/http"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	preferencesapi "github.com/tutti-os/tutti/services/tuttid/api/preferences"
	workspaceapi "github.com/tutti-os/tutti/services/tuttid/api/workspace"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentmaintenanceservice "github.com/tutti-os/tutti/services/tuttid/service/agentmaintenance"
	agentstatusservice "github.com/tutti-os/tutti/services/tuttid/service/agentstatus"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
	managedcredentialsservice "github.com/tutti-os/tutti/services/tuttid/service/managedcredentials"
	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

type EventStreamService interface {
	OpenSession() *eventstreamservice.Session
	CloseSession(*eventstreamservice.Session)
	Events(*eventstreamservice.Session) <-chan eventstreamservice.PublishedEvent
	Subscribe(*eventstreamservice.Session, []string, eventstreamservice.EventScope) error
	Unsubscribe(*eventstreamservice.Session, []string, eventstreamservice.EventScope) error
	PublishFromClient(context.Context, eventstreamservice.ClientEvent) error
	PublishFromServer(context.Context, string, []byte) error
}

type DaemonAPI struct {
	UserProjectService         UserProjectService
	AgentQuickPromptService    AgentQuickPromptService
	AgentTargetService         AgentTargetService
	AgentTargetSetupService    AgentTargetSetupService
	PreferencesService         preferencesapi.Service
	AgentMaintenanceService    AgentMaintenanceService
	ManagedCredentialsService  *managedcredentialsservice.Service
	ModelPlanService           ModelPlanService
	WorkspaceAgentService      WorkspaceAgentService
	AgentModelBindingService   AgentModelBindingService
	ModelPolicyService         ModelPolicyService
	CollaborationRunService    CollaborationRunService
	AutomationRuleService      AutomationRuleService
	AccountService             AccountService
	MobileRemoteService        MobileRemoteService
	EventStreamService         EventStreamService
	WorkspaceService           workspaceapi.CatalogService
	WorkbenchService           workspaceapi.WorkbenchService
	AppCenterService           workspaceapi.AppCenterService
	AppFactoryService          AppFactoryService
	FileService                workspaceapi.FileService
	AgentSessionService        AgentSessionService
	AgentStatusService         AgentProviderStatusService
	TerminalService            workspaceapi.TerminalService
	IssueService               workspaceapi.IssueManagerService
	TuttiModePlanService       TuttiModePlanService
	TuttiModeActivationService TuttiModeActivationService
	CLIRegistry                *cliservice.Registry
	AnalyticsReporter          reporterservice.Reporter
}

type AgentMaintenanceService interface {
	PurgeNow(context.Context) (agentmaintenanceservice.PurgeResult, error)
}

type AgentProviderStatusService interface {
	List(context.Context, agentstatusservice.ListInput) (agentstatusservice.Snapshot, error)
	Probe(context.Context, agentstatusservice.ProbeInput) (agentstatusservice.ProbeResult, error)
	RunAction(context.Context, agentstatusservice.RunActionInput) (agentstatusservice.RunActionResult, error)
}

var _ tuttigenerated.StrictServerInterface = (*DaemonAPI)(nil)

type daemonRoutes struct {
	tuttigenerated.ServerInterface
	api DaemonAPI
}

func NewRoutes(api DaemonAPI) Routes {
	return daemonRoutes{
		ServerInterface: tuttigenerated.NewStrictHandlerWithOptions(api, nil, strictServerOptions()),
		api:             api,
	}
}

func strictServerOptions() tuttigenerated.StrictHTTPServerOptions {
	return tuttigenerated.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: requestServerErrorHandler,
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, _ *http.Request, err error) {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		},
	}
}

func requestServerErrorHandler(w http.ResponseWriter, _ *http.Request, err error) {
	protocolErr := apierrors.MalformedRequest(apierrors.WithCause(err))
	if strings.Contains(strings.TrimSpace(err.Error()), "EOF") {
		protocolErr = apierrors.EmptyBody(apierrors.WithDeveloperMessage("empty body"))
	}
	tuttitypes.WriteError(
		w,
		http.StatusBadRequest,
		string(protocolErr.Code),
		protocolErr.Reason,
		protocolErr.DeveloperMessage,
	)
}

func (DaemonAPI) GetHealth(_ context.Context, _ tuttigenerated.GetHealthRequestObject) (tuttigenerated.GetHealthResponseObject, error) {
	return tuttigenerated.GetHealth200JSONResponse{
		Service: "tuttid",
		Status:  tuttigenerated.Ok,
	}, nil
}
