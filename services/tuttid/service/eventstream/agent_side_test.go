package eventstream

import "testing"

func TestAgentSideUpdatedPayloadValidatesDiscriminatedData(t *testing.T) {
	t.Parallel()
	catalog := DefaultCatalog()
	tests := []struct {
		name    string
		payload string
		valid   bool
	}{
		{
			name:    "message delta",
			payload: `{"workspaceId":"workspace-1","sideAgentSessionId":"side-1","sourceAgentSessionId":"source-1","sequence":1,"eventType":"message_delta","data":{"messageId":"message-1","turnId":"turn-1","role":"assistant","content":{"operation":"append_text","value":"hi"}}}`,
			valid:   true,
		},
		{
			name:    "message update",
			payload: `{"workspaceId":"workspace-1","sideAgentSessionId":"side-1","sourceAgentSessionId":"source-1","sequence":2,"eventType":"message_update","data":{"messageId":"message-1","role":"assistant","contentDelta":"done"}}`,
			valid:   true,
		},
		{
			name:    "interaction state patch",
			payload: `{"workspaceId":"workspace-1","sideAgentSessionId":"side-1","sourceAgentSessionId":"source-1","sequence":3,"eventType":"state_patch","data":{"interactionTransition":{"requestId":"request-1","turnId":"turn-1","kind":"approval","status":"pending"}}}`,
			valid:   true,
		},
		{
			name:    "missing delta identity",
			payload: `{"workspaceId":"workspace-1","sideAgentSessionId":"side-1","sourceAgentSessionId":"source-1","sequence":1,"eventType":"message_delta","data":{"role":"assistant"}}`,
		},
		{
			name:    "unsupported content operation",
			payload: `{"workspaceId":"workspace-1","sideAgentSessionId":"side-1","sourceAgentSessionId":"source-1","sequence":1,"eventType":"message_delta","data":{"messageId":"message-1","turnId":"turn-1","role":"assistant","content":{"operation":"replace_all"}}}`,
		},
		{
			name:    "invalid interaction kind",
			payload: `{"workspaceId":"workspace-1","sideAgentSessionId":"side-1","sourceAgentSessionId":"source-1","sequence":1,"eventType":"state_patch","data":{"interactionTransition":{"requestId":"request-1","turnId":"turn-1","kind":"other","status":"pending"}}}`,
		},
		{
			name:    "array data",
			payload: `{"workspaceId":"workspace-1","sideAgentSessionId":"side-1","sourceAgentSessionId":"source-1","sequence":1,"eventType":"session_audit","data":[]}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := catalog.ValidatePublish(
				TopicAgentSideUpdated,
				DirectionServerToClient,
				[]byte(test.payload),
			)
			if test.valid && err != nil {
				t.Fatalf("ValidatePublish() error = %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("ValidatePublish() accepted invalid Side payload")
			}
		})
	}
}
