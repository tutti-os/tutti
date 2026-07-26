package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func registerAgentEditRetryRoutes(
	mux *http.ServeMux,
	wrapper *tuttigenerated.ServerInterfaceWrapper,
) {
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/turns/{turnID}/edit-retry", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.EditRetryWorkspaceAgentTurn(w, r)
	})

	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/edit-retry-operations/{operationID}/recover", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.RecoverWorkspaceAgentEditRetry(w, r)
	})
}
