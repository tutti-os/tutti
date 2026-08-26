package api

import (
	"context"
	"net/http"
	"strings"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	admissiondaemon "github.com/tutti-os/tutti/packages/desktop/update-admission/daemon"
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

type DesktopUpdateAdmissionService interface {
	WaitInitial(context.Context) (admissiondaemon.Snapshot, error)
	Snapshot() admissiondaemon.Snapshot
	Refresh(context.Context, admissiondaemon.RefreshTrigger) (admissiondaemon.RefreshResult, error)
}

type DaemonAPI struct {
	UserProjectService            UserProjectService
	AgentQuickPromptService       AgentQuickPromptService
	AgentTargetService            AgentTargetService
	AgentTargetSetupService       AgentTargetSetupService
	AgentTargetAccountUsage       AgentTargetAccountUsageService
	PreferencesService            preferencesapi.Service
	AgentMaintenanceService       AgentMaintenanceService
	ManagedCredentialsService     *managedcredentialsservice.Service
	ModelPlanService              ModelPlanService
	WorkspaceAgentService         WorkspaceAgentService
	AgentModelBindingService      AgentModelBindingService
	ModelPolicyService            ModelPolicyService
	CollaborationRunService       CollaborationRunService
	AutomationRuleService         AutomationRuleService
	AccountService                AccountService
	MobileRemoteService           MobileRemoteService
	UserPresenceService           UserPresenceService
	EventStreamService            EventStreamService
	WorkspaceService              workspaceapi.CatalogService
	WorkbenchService              workspaceapi.WorkbenchService
	AppCenterService              workspaceapi.AppCenterService
	AppFactoryService             AppFactoryService
	FileService                   workspaceapi.FileService
	AgentSessionService           AgentSessionService
	AgentSessionRecordingService  AgentSessionRecordingService
	AgentSessionReplayVerifier    AgentSessionReplayVerifier
	AgentStatusService            AgentProviderStatusService
	TuttiAgentReadiness           TuttiAgentReadiness
	TerminalService               workspaceapi.TerminalService
	IssueService                  workspaceapi.IssueManagerService
	IssueExecutionService         workspaceapi.IssueExecutionService
	TuttiModePlanService          TuttiModePlanService
	TuttiModeExecutionService     TuttiModeExecutionService
	TuttiModeActivationService    TuttiModeActivationService
	TuttiModeGoalReviewService    TuttiModeGoalReviewService
	CLIRegistry                   *cliservice.Registry
	AnalyticsReporter             reporterservice.Reporter
	DesktopUpdateAdmissionService DesktopUpdateAdmissionService
	SideConversationService       SideConversationService
	ConnectorMarketService        market.Service
	ConnectorMarketScope          func() market.OperationScope
	ConnectorAuthorizationReady   func(string) bool
	// OnListenerReady starts daemon work that may wake an Agent whose next
	// action calls back into tuttid. Wiring invokes it only after publishing
	// listener information.
	OnListenerReady func()
}

type TuttiAgentReadiness interface {
	Trigger(reason string)
	ProviderActionCompleted(agentstatusservice.RunActionResult)
}

type AgentMaintenanceService interface {
	PurgeNow(context.Context) (agentmaintenanceservice.PurgeResult, error)
	PurgeWorkspace(context.Context, string) (agentmaintenanceservice.PurgeResult, error)
	PurgeSession(context.Context, string, string) (agentmaintenanceservice.PurgeResult, error)
}

type AgentProviderStatusService interface {
	List(context.Context, agentstatusservice.ListInput) (agentstatusservice.Snapshot, error)
	Probe(context.Context, agentstatusservice.ProbeInput) (agentstatusservice.ProbeResult, error)
	RunAction(context.Context, agentstatusservice.RunActionInput) (agentstatusservice.RunActionResult, error)
	GetCodexRuntimeCatalog(context.Context, string) (agentstatusservice.CodexRuntimeCatalog, error)
	SetCodexRuntimeSelection(context.Context, agentstatusservice.SetCodexRuntimeSelectionInput) (agentstatusservice.CodexRuntimeCatalog, error)
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
