package api

import (
	"context"
	"errors"
	"net/http"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
)

type stubAgentExtensionCatalogService struct {
	entries []agentextensionservice.CatalogEntry
	err     error
}

func (s stubAgentExtensionCatalogService) ListCatalog(context.Context) ([]agentextensionservice.CatalogEntry, error) {
	return s.entries, s.err
}

func TestDaemonAPIGeneratedRouteListsAgentExtensionCatalog(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{AgentExtensionCatalogService: stubAgentExtensionCatalogService{
		entries: []agentextensionservice.CatalogEntry{{
			Key:      "gemini",
			TargetID: "extension:gemini",
			Name:     "Gemini CLI",
			IconURL:  "data:image/svg+xml;base64,gemini",
		}},
	}}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/agent-extensions/catalog", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", recorder.Code, recorder.Body.String())
	}
	var response tuttigenerated.AgentExtensionCatalogResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if len(response.Extensions) != 1 || response.Extensions[0].TargetId != "extension:gemini" || response.Extensions[0].IconUrl != "data:image/svg+xml;base64,gemini" {
		t.Fatalf("response = %#v", response)
	}
}

func TestDaemonAPIGeneratedRouteMapsAgentExtensionCatalogErrors(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{AgentExtensionCatalogService: stubAgentExtensionCatalogService{
		err: errors.New("catalog unavailable"),
	}}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/agent-extensions/catalog", nil)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadGateway, recorder.Body.String())
	}
}

func TestDaemonAPIGeneratedRouteRequiresAgentExtensionCatalogService(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/agent-extensions/catalog", nil)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusServiceUnavailable, recorder.Body.String())
	}
}
