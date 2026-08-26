package agentruntime

import "testing"

func TestStandardACPResumeModeMatchesPersistedSelection(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name           string
		permissionMode string
		planMode       bool
		runtimeContext map[string]any
		targetMode     string
		want           bool
	}{
		{
			name:           "same semantic selection overrides stale provider projection",
			permissionMode: "plan",
			runtimeContext: map[string]any{"permissionModeId": "plan", "planMode": false, "mode": "default"},
			targetMode:     "plan",
			want:           true,
		},
		{
			name:           "permission changed while detached",
			permissionMode: "yolo",
			runtimeContext: map[string]any{"permissionModeId": "plan", "planMode": false, "mode": "plan"},
			targetMode:     "yolo",
			want:           false,
		},
		{
			name:           "plan setting changed while detached",
			permissionMode: "default",
			planMode:       true,
			runtimeContext: map[string]any{"permissionModeId": "default", "planMode": false},
			targetMode:     "plan",
			want:           false,
		},
		{
			name:           "legacy runtime mode fallback",
			permissionMode: "plan",
			runtimeContext: map[string]any{"mode": "plan"},
			targetMode:     "plan",
			want:           true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			session := standardTestSession("acp:resume-sensitive")
			session.PermissionModeID = tt.permissionMode
			session.Settings = &SessionSettings{PlanMode: tt.planMode}
			session.RuntimeContext = tt.runtimeContext
			if got := standardACPResumeModeMatchesPersistedSelection(session, tt.targetMode); got != tt.want {
				t.Fatalf("standardACPResumeModeMatchesPersistedSelection() = %v, want %v", got, tt.want)
			}
		})
	}
}
