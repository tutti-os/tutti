package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func registerAgentSessionRecordingRoutes(
	mux *http.ServeMux,
	wrapper *tuttigenerated.ServerInterfaceWrapper,
) {
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-recordings", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListAgentSessionRecordings(w, r)
		case http.MethodPost:
			wrapper.StartAgentSessionRecording(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-recordings/{recordingID}", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.GetAgentSessionRecording(w, r)
		case http.MethodPatch:
			wrapper.RenameAgentSessionRecording(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-recordings/{recordingID}/complete", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CompleteAgentSessionRecording(w, r)
	})
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-recordings/{recordingID}/activity-events", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.AppendAgentSessionRecordingActivityEvents(w, r)
	})
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-recordings/{recordingID}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CancelAgentSessionRecording(w, r)
	})
}
