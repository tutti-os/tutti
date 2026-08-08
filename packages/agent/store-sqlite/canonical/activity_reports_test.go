package canonical

import (
	"encoding/json"
	"testing"
)

func TestWorkspaceAgentMessageSemanticsEncodesExplicitFalseVisibility(t *testing.T) {
	raw, err := json.Marshal(WorkspaceAgentMessageSemantics{UserVisibleAssistantResponse: false})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if got, want := string(raw), `{"userVisibleAssistantResponse":false}`; got != want {
		t.Fatalf("semantics JSON = %s, want %s", got, want)
	}
}
