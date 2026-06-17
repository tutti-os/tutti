package agentruntime

import (
	"reflect"
	"testing"
)

func TestSessionSettingsPayloadRoundTrip(t *testing.T) {
	falseValue := false
	cases := []*SessionSettings{
		nil,
		{
			Model:            "gpt-5",
			PermissionModeID: "auto",
			PlanMode:         true,
			ReasoningEffort:  "high",
		},
		{
			BrowserUse: &falseValue,
		},
	}
	for _, settings := range cases {
		payload := sessionSettingsPayload(settings)
		got := sessionSettingsFromPayload(payload)
		if !reflect.DeepEqual(settings, got) {
			t.Fatalf("round-trip mismatch: input=%#v payload=%#v got=%#v", settings, payload, got)
		}
	}
}
