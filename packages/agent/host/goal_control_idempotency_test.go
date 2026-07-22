package agenthost

import "testing"

func TestGoalControlOperationIDUsesCallerStableIdentity(t *testing.T) {
	first := goalControlOperationID("workspace-1", "session-1", "submit-1")
	second := goalControlOperationID(" workspace-1 ", " session-1 ", " submit-1 ")
	if first != second {
		t.Fatalf("stable operation IDs differ: %q != %q", first, second)
	}
	if other := goalControlOperationID("workspace-1", "session-1", "submit-2"); other == first {
		t.Fatalf("different client submit IDs produced %q", first)
	}
}

func TestGoalControlClientSubmitIDPrefersTypedField(t *testing.T) {
	input := GoalControlInput{ClientSubmitID: " typed-id "}
	if got := goalControlClientSubmitID(input, map[string]any{"clientSubmitId": "legacy-id"}); got != "typed-id" {
		t.Fatalf("client submit ID = %q, want typed-id", got)
	}
}
