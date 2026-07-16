package activityreplication_test

import (
	"encoding/json"
	"testing"

	activityreplication "github.com/tutti-os/tutti/packages/agent/activity-replication"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestValidateMutationAcceptsEveryProjectionSnapshot(t *testing.T) {
	t.Parallel()

	sessionScope := &activityreplication.SessionScope{
		ExecutorOwnerUserID: "owner-1", SourceDeviceID: "device-1",
		Visibility: activityreplication.VisibilityMembers,
	}
	base := func(entityType activityreplication.EntityType, key activityreplication.EntityKey) activityreplication.Mutation {
		return activityreplication.Mutation{
			SchemaVersion: activityreplication.SchemaVersion, MutationID: "mutation-1", TransactionID: "transaction-1",
			SourceDeviceID: "device-1", WorkspaceID: "workspace-1", EntityType: entityType,
			Operation: activityreplication.OperationUpsert, Key: key,
		}
	}
	turnID := "turn-1"
	tests := []struct {
		name     string
		mutation activityreplication.Mutation
	}{
		{
			name: "target",
			mutation: func() activityreplication.Mutation {
				mutation := base(activityreplication.EntityTarget, activityreplication.EntityKey{AgentTargetID: "target-1"})
				mutation.Target = &activityreplication.Target{ID: "target-1", LaunchRef: json.RawMessage(`{}`)}
				mutation.TargetScope = &activityreplication.TargetScope{OwnerUserID: "owner-1", OwnerDeviceID: "device-1"}
				return mutation
			}(),
		},
		{
			name: "session",
			mutation: func() activityreplication.Mutation {
				mutation := base(activityreplication.EntitySession, activityreplication.EntityKey{AgentSessionID: "session-1"})
				mutation.Session = &activityreplication.Session{
					WorkspaceID: "workspace-1", AgentSessionID: "session-1", Kind: canonical.SessionKindRoot,
					Origin:   "runtime",
					Settings: json.RawMessage(`{}`), SessionMetadata: json.RawMessage(`{}`),
					InternalRuntimeContext: json.RawMessage(`{}`), RailSectionKey: "conversations",
				}
				mutation.SessionScope = sessionScope
				return mutation
			}(),
		},
		{
			name: "turn",
			mutation: func() activityreplication.Mutation {
				mutation := base(activityreplication.EntityTurn, activityreplication.EntityKey{AgentSessionID: "session-1", TurnID: turnID})
				mutation.Turn = &activityreplication.Turn{
					WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: turnID,
					Phase: canonical.TurnPhaseRunning, Origin: canonical.TurnOriginUserPrompt,
				}
				mutation.SessionScope = sessionScope
				return mutation
			}(),
		},
		{
			name: "interaction",
			mutation: func() activityreplication.Mutation {
				mutation := base(activityreplication.EntityInteraction, activityreplication.EntityKey{
					AgentSessionID: "session-1", TurnID: turnID, RequestID: "request-1",
				})
				mutation.Interaction = &activityreplication.Interaction{
					WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: turnID, RequestID: "request-1",
					Kind: canonical.InteractionKindQuestion, Status: canonical.InteractionStatusPending,
					Input: json.RawMessage(`{}`), Output: json.RawMessage(`{}`), Metadata: json.RawMessage(`{}`),
				}
				mutation.SessionScope = sessionScope
				return mutation
			}(),
		},
		{
			name: "message",
			mutation: func() activityreplication.Mutation {
				mutation := base(activityreplication.EntityMessage, activityreplication.EntityKey{
					AgentSessionID: "session-1", MessageID: "message-1",
				})
				mutation.Message = &activityreplication.Message{
					WorkspaceID: "workspace-1", AgentSessionID: "session-1", MessageID: "message-1", Version: 1,
					TurnID: &turnID, Role: "assistant", Kind: "text", Payload: json.RawMessage(`{}`),
				}
				mutation.SessionScope = sessionScope
				return mutation
			}(),
		},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if err := activityreplication.ValidateMutation(test.mutation); err != nil {
				t.Fatalf("ValidateMutation() error = %v", err)
			}
		})
	}
}

func TestValidateMutationRejectsTrailingJSON(t *testing.T) {
	t.Parallel()

	mutation := activityreplication.Mutation{
		SchemaVersion: activityreplication.SchemaVersion, MutationID: "mutation-1", TransactionID: "transaction-1",
		SourceDeviceID: "device-1", WorkspaceID: "workspace-1", EntityType: activityreplication.EntityTarget,
		Operation: activityreplication.OperationUpsert, Key: activityreplication.EntityKey{AgentTargetID: "target-1"},
		Target:      &activityreplication.Target{ID: "target-1", LaunchRef: json.RawMessage(`{} {}`)},
		TargetScope: &activityreplication.TargetScope{OwnerUserID: "owner-1", OwnerDeviceID: "device-1"},
	}
	if err := activityreplication.ValidateMutation(mutation); err == nil {
		t.Fatal("ValidateMutation() error = nil")
	}
}
