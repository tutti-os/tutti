package agent

import "testing"

func TestReasoningEffortForIntensityUsesOrderedEqualBands(t *testing.T) {
	t.Parallel()
	values := []string{"low", "medium", "high", "xhigh"}
	tests := []struct {
		intensity int
		want      string
	}{
		{intensity: 0, want: "low"},
		{intensity: 24, want: "low"},
		{intensity: 25, want: "low"},
		{intensity: 26, want: "medium"},
		{intensity: 50, want: "medium"},
		{intensity: 51, want: "high"},
		{intensity: 75, want: "high"},
		{intensity: 76, want: "xhigh"},
		{intensity: 100, want: "xhigh"},
	}
	for _, test := range tests {
		if got := reasoningEffortForIntensity(values, test.intensity); got != test.want {
			t.Errorf("reasoningEffortForIntensity(%d) = %q, want %q", test.intensity, got, test.want)
		}
	}
}

func TestReasoningEffortForIntensityNormalizesCatalog(t *testing.T) {
	t.Parallel()
	if got := reasoningEffortForIntensity([]string{"", " low ", "low", "high"}, 100); got != "high" {
		t.Fatalf("reasoningEffortForIntensity() = %q, want high", got)
	}
}
