package eventstream

import "testing"

func TestAgentSessionLaunchModePatchPayloadValidation(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		payload string
		valid   bool
	}{
		{name: "invalid json", payload: `{`, valid: false},
		{name: "missing workspace", payload: `{"workspaceId":" ","projectSectionKey":"project:/alpha","mode":"worktree"}`, valid: false},
		{name: "missing project", payload: `{"workspaceId":"workspace-1","projectSectionKey":" ","mode":"worktree"}`, valid: false},
		{name: "unsupported mode", payload: `{"workspaceId":"workspace-1","projectSectionKey":"project:/alpha","mode":"remote"}`, valid: false},
		{name: "local", payload: `{"workspaceId":"workspace-1","projectSectionKey":"project:/alpha","mode":"local"}`, valid: true},
		{name: "worktree", payload: `{"workspaceId":"workspace-1","projectSectionKey":"project:/alpha","mode":"worktree"}`, valid: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateAgentSessionLaunchModePatchRequestedPayload([]byte(test.payload))
			if (err == nil) != test.valid {
				t.Fatalf("validation error = %v, valid = %v", err, test.valid)
			}
		})
	}
}
