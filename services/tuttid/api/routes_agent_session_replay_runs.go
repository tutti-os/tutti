package api

import (
	"net/http"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func registerAgentSessionReplayRunRoutes(
	mux *http.ServeMux,
	wrapper *tuttigenerated.ServerInterfaceWrapper,
) {
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-cassettes", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.ListAgentSessionCassettes(w, r)
	})
	mux.HandleFunc("/v1/agent-session-replay/transport/verify", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.VerifyAgentSessionReplayTransport(w, r)
	})
	mux.HandleFunc("/v1/agent-session-replay/transport/playback", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.GetAgentSessionReplayTransportPlayback(w, r)
		case http.MethodPost:
			wrapper.UpdateAgentSessionReplayTransportPlayback(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-cassettes/{cassetteID}/replay-runs", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			wrapper.ListAgentSessionReplayRuns(w, r)
		case http.MethodPost:
			wrapper.PrepareAgentSessionReplayRun(w, r)
		default:
			tuttitypes.WriteMethodNotAllowed(w)
		}
	})
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-replay-runs/{runID}/running", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.MarkAgentSessionReplayRunRunning(w, r)
	})
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-replay-runs/{runID}/checkpoint", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.AdvanceAgentSessionReplayRunCheckpoint(w, r)
	})
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-replay-runs/{runID}/cancel", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CancelAgentSessionReplayRun(w, r)
	})
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-replay-runs/{runID}/complete", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.CompleteAgentSessionReplayRun(w, r)
	})
	mux.HandleFunc("/v1/workspaces/{workspaceID}/agent-session-replay-runs/{runID}/fail", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			tuttitypes.WriteMethodNotAllowed(w)
			return
		}
		wrapper.FailAgentSessionReplayRun(w, r)
	})
}
