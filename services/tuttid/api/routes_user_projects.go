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

func registerUserProjectRoutes(mux *http.ServeMux, wrapper *tuttigenerated.ServerInterfaceWrapper) {
	mux.HandleFunc("/v1/user-projects", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListUserProjects(w, r)
		case http.MethodPost:
			wrapper.UseUserProject(w, r)
		case http.MethodDelete:
			wrapper.DeleteUserProject(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})

	mux.HandleFunc("/v1/user-projects/check", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CheckUserProjectPath(w, r)
	})

	mux.HandleFunc("/v1/user-projects/move", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		if !moveRequestHasBeforeProjectID(w, r) {
			return
		}
		wrapper.MoveUserProject(w, r)
	})

	mux.HandleFunc("/v1/user-projects/pin", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.PinUserProject(w, r)
	})
}

// The generated Go pointer cannot distinguish an omitted required-nullable
// field from an explicit JSON null. Preserve that transport distinction here;
// the strict generated decoder still owns all other shape validation.
func moveRequestHasBeforeProjectID(w http.ResponseWriter, r *http.Request) bool {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		tuttitypes.WriteJSON(w, http.StatusBadRequest, protocolErrorResponse(apierrors.MalformedRequest(
			apierrors.WithDeveloperMessage("cannot read user project move request body"),
		)))
		return false
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		return true
	}
	if _, ok := fields["beforeProjectId"]; ok {
		return true
	}
	tuttitypes.WriteJSON(w, http.StatusBadRequest, protocolErrorResponse(apierrors.MalformedRequest(
		apierrors.WithDeveloperMessage("beforeProjectId is required"),
		apierrors.WithParams(map[string]any{"field": "beforeProjectId"}),
	)))
	return false
}
