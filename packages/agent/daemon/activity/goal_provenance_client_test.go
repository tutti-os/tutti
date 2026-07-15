package agentsessionstore

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientBindAndLookupGoalProvenance(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s", r.Method)
		}
		switch r.URL.Path {
		case "/v1/rooms/ws/agents/sessions/session/goal-provenance/bind":
			var input BindGoalProvenanceInput
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Fatal(err)
			}
			if input.ProviderSessionID != "provider-session" || input.Fingerprint != "generation" || input.OperationID != "operation" {
				t.Fatalf("bind input = %#v", input)
			}
			_ = json.NewEncoder(w).Encode(GoalProvenanceBinding{
				WorkspaceID: "ws", AgentSessionID: "session", ProviderSessionID: "provider-session",
				Fingerprint: "generation", OperationID: "operation", Revision: 2, RepairEpoch: 1,
			})
		case "/v1/rooms/ws/agents/sessions/session/goal-provenance/lookup":
			_ = json.NewEncoder(w).Encode(LookupGoalProvenanceReply{
				Found: true,
				Binding: GoalProvenanceBinding{
					WorkspaceID: "ws", AgentSessionID: "session", ProviderSessionID: "provider-session",
					Fingerprint: "generation", Ambiguous: true,
				},
			})
		default:
			t.Fatalf("path = %s", r.URL.Path)
		}
	}))
	defer server.Close()
	client := NewClient(Config{BaseURL: server.URL})
	binding, err := client.BindGoalProvenance(context.Background(), BindGoalProvenanceInput{
		WorkspaceID: " ws ", AgentSessionID: " session ", ProviderSessionID: "provider-session",
		Fingerprint: "generation", OperationID: "operation", Revision: 2, RepairEpoch: 1,
	})
	if err != nil || binding.OperationID != "operation" || binding.Revision != 2 {
		t.Fatalf("BindGoalProvenance = %#v, %v", binding, err)
	}
	binding, found, err := client.LookupGoalProvenance(context.Background(), LookupGoalProvenanceInput{
		WorkspaceID: "ws", AgentSessionID: "session", ProviderSessionID: "provider-session", Fingerprint: "generation",
	})
	if err != nil || !found || !binding.Ambiguous {
		t.Fatalf("LookupGoalProvenance = %#v, found=%v, err=%v", binding, found, err)
	}
}
