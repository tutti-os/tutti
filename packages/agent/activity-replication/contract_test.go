package activityreplication_test

import (
	"encoding/json"
	"errors"
	"testing"

	activityreplication "github.com/tutti-os/tutti/packages/agent/activity-replication"
)

func TestLegacyCommandStateOnlyDecodesAsDeleteTombstone(t *testing.T) {
	t.Parallel()

	var mutation activityreplication.Mutation
	if err := json.Unmarshal([]byte(`{
  "schemaVersion": 1,
  "mutationId": "delete-operation",
  "transactionId": "transaction-1",
  "sourceDeviceId": "device-1",
  "workspaceId": "workspace-1",
  "entityType": "runtimeOperation",
  "operation": "delete",
  "key": {"agentSessionId": "session-1", "operationId": "operation-1"}
}`), &mutation); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if err := activityreplication.ValidateMutation(mutation); err != nil {
		t.Fatalf("ValidateMutation(delete) error = %v", err)
	}

	mutation.Operation = activityreplication.OperationUpsert
	if err := activityreplication.ValidateMutation(mutation); err == nil {
		t.Fatal("ValidateMutation(upsert) error = nil, want permanent schema rejection")
	} else {
		var rejection *activityreplication.PermanentRejection
		if !errors.As(err, &rejection) || rejection.Kind != activityreplication.RejectionSchema ||
			rejection.MutationID != mutation.MutationID || rejection.TransactionID != mutation.TransactionID {
			t.Fatalf("ValidateMutation(upsert) error = %#v", err)
		}
	}
}

func TestAcknowledgementSemantics(t *testing.T) {
	t.Parallel()

	mutation := activityreplication.Mutation{MutationID: "mutation-1", TransactionID: "transaction-retry"}
	result, err := activityreplication.SummarizeAcknowledgements([]activityreplication.MutationAcknowledgement{
		activityreplication.AcknowledgeDuplicate(mutation, 7),
		activityreplication.AcknowledgeStale(mutation),
		activityreplication.AcknowledgeApplied(mutation, 9),
	})
	if err != nil {
		t.Fatalf("SummarizeAcknowledgements() error = %v", err)
	}
	if result.AcceptedCount != 3 || result.Cursor != 9 {
		t.Fatalf("SummarizeAcknowledgements() = %#v", result)
	}
}

func TestPermanentRejectionsPreserveMutationAndTransactionIdentity(t *testing.T) {
	t.Parallel()

	mutation := activityreplication.Mutation{MutationID: "mutation-1", TransactionID: "transaction-1"}
	for _, kind := range []activityreplication.RejectionKind{
		activityreplication.RejectionSchema,
		activityreplication.RejectionIdentity,
		activityreplication.RejectionPermission,
	} {
		kind := kind
		t.Run(string(kind), func(t *testing.T) {
			t.Parallel()
			err := activityreplication.NewPermanentRejection(kind, mutation, errors.New("rejected"))
			var rejection *activityreplication.PermanentRejection
			if !errors.As(err, &rejection) || rejection.Kind != kind || rejection.MutationID != mutation.MutationID ||
				rejection.TransactionID != mutation.TransactionID {
				t.Fatalf("NewPermanentRejection() = %#v", err)
			}
		})
	}
}
