package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func registerAgentTargetRoutes(mux *http.ServeMux, wrapper *tuttigenerated.ServerInterfaceWrapper) {
	mux.HandleFunc("/v1/agent-targets", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListAgentTargets(w, r)
	})

	mux.HandleFunc("/v1/agent-targets/{agentTargetID}/enabled", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPatch {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.SetSystemAgentTargetEnabled(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-targets/{agentTargetID}/setup", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.GetAgentTargetSetup(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-targets/{agentTargetID}/setup/install", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.InstallAgentTargetRuntime(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-targets/{agentTargetID}/setup/authenticate", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.AuthenticateAgentTargetRuntime(w, r)
	})
}
