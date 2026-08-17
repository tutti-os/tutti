package eventstream

import (
	"strings"
	"testing"
)

func TestDesktopPreferencesValidatorsRejectInvalidSessionLaunchModes(t *testing.T) {
	tests := []struct {
		name    string
		payload string
	}{
		{
			name:    "unsupported mode",
			payload: `{"preferences":{"agentSessionLaunchModesByWorkspace":{"workspace-1":{"project:alpha":"remote"}}}}`,
		},
		{
			name:    "empty workspace id",
			payload: `{"preferences":{"agentSessionLaunchModesByWorkspace":{"":{"project:alpha":"worktree"}}}}`,
		},
		{
			name:    "empty project section key",
			payload: `{"preferences":{"agentSessionLaunchModesByWorkspace":{"workspace-1":{"":"worktree"}}}}`,
		},
	}
	validators := []struct {
		name     string
		validate func([]byte) error
	}{
		{name: "client intent", validate: validateDesktopPreferencesUpdateRequestedPayload},
		{name: "server event", validate: validateDesktopPreferencesUpdatedPayload},
	}

	for _, validator := range validators {
		for _, test := range tests {
			t.Run(validator.name+"/"+test.name, func(t *testing.T) {
				err := validator.validate([]byte(test.payload))
				if err == nil || !strings.Contains(err.Error(), "agentSessionLaunchModesByWorkspace") {
					t.Fatalf("validation error = %v, want launch-mode rejection", err)
				}
			})
		}
	}
}
