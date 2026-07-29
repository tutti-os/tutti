package api

import (
	"context"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestSubmitWorkspaceAgentInteractiveBuildsTypedHostCommand(t *testing.T) {
	var gotRef agenthost.InteractionRef
	var gotInput agenthost.SubmitInteractiveInput
	action, option := "approve", "allow-once"
	payload := map[string]any{"answer": "yes"}
	api := DaemonAPI{AgentSessionService: stubAgentSessionService{
		submitInteractiveFn: func(_ context.Context, ref agenthost.InteractionRef, input agenthost.SubmitInteractiveInput) (agentservice.Session, error) {
			gotRef, gotInput = ref, input
			return agentservice.Session{ID: ref.AgentSessionID}, nil
		},
	}}

	response, err := api.SubmitWorkspaceAgentInteractive(context.Background(), tuttigenerated.SubmitWorkspaceAgentInteractiveRequestObject{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", RequestID: "request-1",
		Body: &tuttigenerated.SubmitWorkspaceAgentInteractiveJSONRequestBody{
			TurnId: "turn-1", Action: &action, OptionId: &option, Payload: &payload,
		},
	})
	if err != nil {
		t.Fatalf("SubmitWorkspaceAgentInteractive() error = %v", err)
	}
	if _, ok := response.(tuttigenerated.SubmitWorkspaceAgentInteractive200JSONResponse); !ok {
		t.Fatalf("response = %T, want 200", response)
	}
	if gotRef != (agenthost.InteractionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1", RequestID: "request-1",
	}) {
		t.Fatalf("interaction ref = %#v", gotRef)
	}
	if gotInput.Action == nil || *gotInput.Action != action || gotInput.OptionID == nil || *gotInput.OptionID != option || gotInput.Payload["answer"] != "yes" {
		t.Fatalf("interactive input = %#v", gotInput)
	}
}
