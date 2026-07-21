package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
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
	mux.HandleFunc("/v1/agent-quick-prompts/move", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		if !moveRequestHasBeforePromptID(w, r) {
			return
		}
		wrapper.MoveAgentQuickPrompt(w, r)
	})
}

// The generated Go pointer cannot distinguish an omitted required-nullable
// field from an explicit JSON null. Preserve that transport distinction here;
// the strict generated decoder still owns every other shape check.
func moveRequestHasBeforePromptID(w http.ResponseWriter, r *http.Request) bool {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		tuttitypes.WriteJSON(w, http.StatusBadRequest, protocolErrorResponse(apierrors.MalformedRequest(
			apierrors.WithDeveloperMessage("cannot read agent quick prompt move request body"),
		)))
		return false
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return true
	}
	if _, ok := fields["beforePromptId"]; ok {
		return true
	}
	tuttitypes.WriteJSON(w, http.StatusBadRequest, protocolErrorResponse(apierrors.MalformedRequest(
		apierrors.WithDeveloperMessage("beforePromptId is required"),
		apierrors.WithParams(map[string]any{"field": "beforePromptId"}),
	)))
	return false
}
