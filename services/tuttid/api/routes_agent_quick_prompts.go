package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func registerAgentQuickPromptRoutes(mux *http.ServeMux, wrapper *tuttigenerated.ServerInterfaceWrapper) {
	mux.HandleFunc("/v1/agent-quick-prompts", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListAgentQuickPrompts(w, r)
		case http.MethodPost:
			wrapper.CreateAgentQuickPrompt(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})
	mux.HandleFunc("/v1/agent-quick-prompts/{promptId}", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			wrapper.UpdateAgentQuickPrompt(w, r)
		case http.MethodDelete:
			wrapper.DeleteAgentQuickPrompt(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})
}
