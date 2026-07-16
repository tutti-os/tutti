package api

import (
	"context"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestGeneratedAgentSessionSettingsExposeModelPlanIdentity(t *testing.T) {
	t.Parallel()

	settings := generatedAgentSessionComposerSettings(agentservice.ComposerSettings{
		Model:       "gpt-new",
		ModelPlanID: "plan-1",
	})
	if settings.ModelPlanId == nil || *settings.ModelPlanId != "plan-1" {
		t.Fatalf("generated settings modelPlanId = %#v", settings.ModelPlanId)
	}
}

func TestUpdateAgentSessionSettingsRejectsModelPlanMutation(t *testing.T) {
	t.Parallel()

	modelPlanID := "plan-2"
	response, err := (DaemonAPI{AgentSessionService: stubAgentSessionService{}}).UpdateWorkspaceAgentSessionSettings(
		context.Background(),
		tuttigenerated.UpdateWorkspaceAgentSessionSettingsRequestObject{
			WorkspaceID:    "ws",
			AgentSessionID: "session-1",
			Body: &tuttigenerated.AgentSessionComposerSettings{
				ModelPlanId: &modelPlanID,
			},
		},
	)
	if err != nil {
		t.Fatalf("UpdateWorkspaceAgentSessionSettings() error = %v", err)
	}
	if _, ok := response.(tuttigenerated.UpdateWorkspaceAgentSessionSettings400JSONResponse); !ok {
		t.Fatalf("response = %T, want 400", response)
	}
}
