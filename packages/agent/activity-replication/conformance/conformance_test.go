package conformance

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	activityreplication "github.com/tutti-os/tutti/packages/agent/activity-replication"
)

func TestPublishedFixturesAreSelfConsistent(t *testing.T) {
	t.Parallel()

	for _, fixture := range ProjectionFixtures() {
		if err := activityreplication.ValidateBatch(fixture.WantBatch); err != nil {
			t.Errorf("projection fixture %q: invalid expected batch: %v", fixture.Name, err)
		}
		if len(fixture.Canonical) != len(fixture.WantBatch.Mutations) {
			t.Errorf("projection fixture %q: %d canonical snapshots, %d expected mutations", fixture.Name, len(fixture.Canonical), len(fixture.WantBatch.Mutations))
		}
	}

	for _, fixture := range SinkFixtures() {
		for _, step := range fixture.Steps {
			err := activityreplication.ValidateBatch(step.Batch)
			if step.WantRejection != nil {
				if step.WantRejection.Kind == activityreplication.RejectionSchema && err == nil {
					t.Errorf("sink fixture %q step %q: schema rejection batch validates", fixture.Name, step.Name)
				}
				continue
			}
			if err != nil {
				t.Errorf("sink fixture %q step %q: invalid batch: %v", fixture.Name, step.Name, err)
				continue
			}
			if len(step.WantAcknowledgements) != len(step.Batch.Mutations) {
				t.Errorf("sink fixture %q step %q: %d acknowledgements, want %d", fixture.Name, step.Name, len(step.WantAcknowledgements), len(step.Batch.Mutations))
				continue
			}
			for index, acknowledgement := range step.WantAcknowledgements {
				mutation := step.Batch.Mutations[index]
				if acknowledgement.MutationID != mutation.MutationID || acknowledgement.TransactionID != mutation.TransactionID {
					t.Errorf("sink fixture %q step %q: acknowledgement %d identity does not match mutation", fixture.Name, step.Name, index)
				}
			}
			result, err := activityreplication.SummarizeAcknowledgements(step.WantAcknowledgements)
			if err != nil || result != step.WantResult {
				t.Errorf("sink fixture %q step %q: summarized result %#v, want %#v, error %v", fixture.Name, step.Name, result, step.WantResult, err)
			}
		}
	}
}

func TestRunSinkRejectsAcknowledgementIdentityMismatch(t *testing.T) {
	t.Parallel()

	mutation := sessionMutation("mutation-1", "transaction-1", "title", 100)
	want := activityreplication.AcknowledgeApplied(mutation, 1)
	got := want
	got.TransactionID = "wrong-transaction"
	sink := &scriptedSink{report: ApplyReport{
		Result:           activityreplication.ApplyResult{AcceptedCount: 1, Cursor: 1},
		Acknowledgements: []activityreplication.MutationAcknowledgement{got},
	}}
	err := RunSink(context.Background(), sink, SinkFixture{
		Name: "identity mismatch",
		Steps: []SinkStep{{
			Name: "apply", Batch: batch(mutation),
			WantResult: activityreplication.ApplyResult{AcceptedCount: 1, Cursor: 1}, WantAcknowledgements: []activityreplication.MutationAcknowledgement{want},
		}},
	})
	if err == nil || !strings.Contains(err.Error(), "acknowledgements") {
		t.Fatalf("RunSink() error = %v, want acknowledgement mismatch", err)
	}
}

func TestRunSinkRejectsResultThatDoesNotSummarizeAcknowledgements(t *testing.T) {
	t.Parallel()

	mutation := sessionMutation("mutation-1", "transaction-1", "title", 100)
	acknowledgement := activityreplication.AcknowledgeApplied(mutation, 2)
	sink := &scriptedSink{report: ApplyReport{
		Result:           activityreplication.ApplyResult{AcceptedCount: 1, Cursor: 1},
		Acknowledgements: []activityreplication.MutationAcknowledgement{acknowledgement},
	}}
	err := RunSink(context.Background(), sink, SinkFixture{
		Name: "aggregate mismatch",
		Steps: []SinkStep{{
			Name: "apply", Batch: batch(mutation),
			WantResult: activityreplication.ApplyResult{AcceptedCount: 1, Cursor: 1}, WantAcknowledgements: []activityreplication.MutationAcknowledgement{acknowledgement},
		}},
	})
	if err == nil || !strings.Contains(err.Error(), "does not summarize") {
		t.Fatalf("RunSink() error = %v, want aggregate mismatch", err)
	}
}

type scriptedSink struct {
	report ApplyReport
	err    error
}

func (*scriptedSink) Reset(context.Context) error { return nil }

func (s *scriptedSink) Apply(context.Context, activityreplication.ChangeBatch) (ApplyReport, error) {
	return s.report, s.err
}

func (*scriptedSink) Lookup(context.Context, activityreplication.EntityType, activityreplication.EntityKey) (json.RawMessage, bool, error) {
	return nil, false, errors.New("unexpected lookup")
}
