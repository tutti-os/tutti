package agentruntime

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type canonicalSubmitSequenceAdapter struct {
	recordingStartAdapter
	release <-chan struct{}
	emitted chan struct{}
	once    sync.Once
}

func TestCanonicalSubmitFactRequiresCompleteIdentityAndOccurrence(t *testing.T) {
	for _, testCase := range []struct {
		name             string
		clientSubmitID   string
		occurredAtUnixMS int64
	}{
		{name: "identity_without_occurrence", clientSubmitID: "submit-1"},
		{name: "occurrence_without_identity", occurredAtUnixMS: 1_234},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := newCanonicalSubmitFact(testCase.clientSubmitID, testCase.occurredAtUnixMS); err == nil {
				t.Fatal("expected incomplete canonical submit fact to fail")
			}
		})
	}
}

func (a *canonicalSubmitSequenceAdapter) ExecAsync(
	ctx context.Context,
	session Session,
	content []PromptContentBlock,
	displayPrompt string,
	turnID string,
	emit EventSink,
	_ CommandSnapshotSink,
) error {
	select {
	case <-a.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	explicitDisplayPrompt, visibleText := explicitAndVisiblePromptText(content, displayPrompt)
	if emit != nil {
		emit([]activityshared.Event{
			newUserPromptActivityEvent(
				ctx,
				session,
				content,
				explicitDisplayPrompt,
				visibleText,
				turnID,
				nil,
			),
		})
	}
	a.once.Do(func() { close(a.emitted) })
	return nil
}

func TestCanonicalSubmitSequenceIsStableAcrossRuntimeAndProvenanceOrder(t *testing.T) {
	for _, provenanceFirst := range []bool{false, true} {
		name := "runtime-first"
		if provenanceFirst {
			name = "provenance-first"
		}
		t.Run(name, func(t *testing.T) {
			release := make(chan struct{})
			adapter := &canonicalSubmitSequenceAdapter{
				recordingStartAdapter: recordingStartAdapter{provider: "canonical-submit-sequence"},
				release:               release,
				emitted:               make(chan struct{}),
			}
			reporter := &recordingReporter{}
			controller := NewController([]Adapter{adapter}, reporter)
			started, err := controller.Start(t.Context(), StartInput{
				RoomID:         "workspace-" + name,
				AgentSessionID: "session-" + name,
				Provider:       adapter.Provider(),
			})
			if err != nil {
				t.Fatal(err)
			}

			const occurredAtUnixMS = int64(1_234)
			const clientSubmitID = "submit-1"
			content := textPrompt("hello")
			execResult, err := controller.Exec(t.Context(), ExecInput{
				RoomID:                          started.Session.RoomID,
				AgentSessionID:                  started.Session.AgentSessionID,
				TurnID:                          "turn-1",
				ClientSubmitID:                  clientSubmitID,
				CanonicalSubmitOccurredAtUnixMS: occurredAtUnixMS,
				Content:                         content,
			})
			if err != nil {
				t.Fatal(err)
			}

			if !provenanceFirst {
				close(release)
				waitForCanonicalSubmitEmission(t, adapter.emitted)
				waitForCanonicalSubmitMessageReports(t, reporter, clientSubmitID, 1)
			}
			if err := controller.DurablyReportSubmitProvenance(t.Context(), SubmitProvenanceInput{
				RoomID:                          started.Session.RoomID,
				AgentSessionID:                  started.Session.AgentSessionID,
				TurnID:                          execResult.TurnID,
				ClientSubmitID:                  clientSubmitID,
				CanonicalSubmitOccurredAtUnixMS: occurredAtUnixMS,
				Content:                         content,
			}); err != nil {
				t.Fatal(err)
			}
			if provenanceFirst {
				close(release)
				waitForCanonicalSubmitEmission(t, adapter.emitted)
			}

			updates := waitForCanonicalSubmitMessageReports(t, reporter, clientSubmitID, 2)
			if !reflect.DeepEqual(updates[0], updates[1]) {
				t.Fatalf("canonical submit updates differ:\nfirst=%#v\nsecond=%#v", updates[0], updates[1])
			}
			if updates[0].Seq != uint64(occurredAtUnixMS) || updates[0].OccurredAtUnixMS != occurredAtUnixMS {
				t.Fatalf("canonical submit sequence = %d occurredAt=%d", updates[0].Seq, updates[0].OccurredAtUnixMS)
			}
			projected := agentsessionstore.SessionMessageUpdateFromActivityUpdate(updates[0])
			if projected.Payload["seq"] != uint64(occurredAtUnixMS) {
				t.Fatalf("canonical payload seq = %#v", projected.Payload["seq"])
			}
		})
	}
}

func waitForCanonicalSubmitEmission(t *testing.T, emitted <-chan struct{}) {
	t.Helper()
	select {
	case <-emitted:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for canonical submit user message")
	}
}

func waitForCanonicalSubmitMessageReports(
	t *testing.T,
	reporter *recordingReporter,
	clientSubmitID string,
	count int,
) []agentsessionstore.WorkspaceAgentMessageUpdate {
	t.Helper()
	messageID := userPromptActivityMessageIDFromClientSubmitID(clientSubmitID)
	var matches []agentsessionstore.WorkspaceAgentMessageUpdate
	reporter.waitForReports(t, "canonical submit message reports", func(calls []reportCall) bool {
		matches = matches[:0]
		for _, call := range calls {
			for _, update := range call.report.MessageUpdates {
				if update.MessageID == messageID {
					matches = append(matches, update)
				}
			}
		}
		return len(matches) >= count
	})
	return append([]agentsessionstore.WorkspaceAgentMessageUpdate(nil), matches...)
}
