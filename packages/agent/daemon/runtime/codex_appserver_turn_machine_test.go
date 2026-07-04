package agentruntime

import "testing"

func TestAppServerTurnProjectionTerminalClassificationMatchesLegacy(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		turn map[string]any
		want codexAppServerTurnPhase
	}{
		{
			name: "completed",
			turn: map[string]any{"id": "turn-1", "status": "completed"},
			want: codexAppServerTurnPhaseCompleted,
		},
		{
			name: "failed",
			turn: map[string]any{"id": "turn-1", "status": "failed"},
			want: codexAppServerTurnPhaseFailed,
		},
		{
			name: "interrupted",
			turn: map[string]any{"id": "turn-1", "status": "interrupted"},
			want: codexAppServerTurnPhaseCanceled,
		},
		{
			name: "unknown remains legacy completed",
			turn: map[string]any{"id": "turn-1", "status": "done"},
			want: codexAppServerTurnPhaseCompleted,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			projected := appServerProjectedTurnTerminalPhase(tt.turn, false)
			legacy := appServerLegacyTurnTerminalPhase(tt.turn)
			if projected != legacy {
				t.Fatalf("projected phase = %q, legacy = %q", projected, legacy)
			}
			if projected != tt.want {
				t.Fatalf("projected phase = %q, want %q", projected, tt.want)
			}
		})
	}
}

func TestAppServerTurnProjectionForceCanceledWins(t *testing.T) {
	t.Parallel()

	turn := map[string]any{"id": "turn-1", "status": "completed"}
	if got := appServerProjectedTurnTerminalPhase(turn, true); got != codexAppServerTurnPhaseCanceled {
		t.Fatalf("force-canceled phase = %q, want %q", got, codexAppServerTurnPhaseCanceled)
	}
}
