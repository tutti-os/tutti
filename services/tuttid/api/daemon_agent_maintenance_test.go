package api

import (
	"context"
	"errors"
	"net/http"
	"testing"

	agentmaintenance "github.com/tutti-os/tutti/services/tuttid/service/agentmaintenance"
)

type stubAgentMaintenanceService struct {
	result agentmaintenance.PurgeResult
	err    error
}

func (s stubAgentMaintenanceService) PurgeNow(context.Context) (agentmaintenance.PurgeResult, error) {
	return s.result, s.err
}

func TestDaemonAPIPurgeDeletedAgentConversations(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{AgentMaintenanceService: stubAgentMaintenanceService{result: agentmaintenance.PurgeResult{
		RemovedSessions: 2,
		RemovedMessages: 5,
		PayloadBytes:    128,
	}}}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-maintenance/deleted-conversations/purge", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		RemovedSessions int `json:"removedSessions"`
		RemovedMessages int `json:"removedMessages"`
	}
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.RemovedSessions != 2 || response.RemovedMessages != 5 {
		t.Fatalf("response = %#v", response)
	}
}

func TestDaemonAPIPurgeDeletedAgentConversationsMapsBusy(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{AgentMaintenanceService: stubAgentMaintenanceService{err: agentmaintenance.ErrBusy}}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-maintenance/deleted-conversations/purge", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("busy status = %d; body: %s", recorder.Code, recorder.Body.String())
	}
}

func TestDaemonAPIPurgeDeletedAgentConversationsMapsFailure(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{AgentMaintenanceService: stubAgentMaintenanceService{err: errors.New("storage failed")}}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/agent-maintenance/deleted-conversations/purge", nil)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("failure status = %d; body: %s", recorder.Code, recorder.Body.String())
	}
}
