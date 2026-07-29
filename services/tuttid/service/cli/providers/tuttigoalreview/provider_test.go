package tuttigoalreview

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	tuttimodeexecutionservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeexecution"
)

type recordingVerdicts struct {
	input tuttimodeexecutionservice.ReviewerVerdictInput
	err   error
}

func (verdicts *recordingVerdicts) SubmitReviewerVerdict(
	_ context.Context,
	input tuttimodeexecutionservice.ReviewerVerdictInput,
) (tuttimodeexecutionservice.ReviewerVerdictResult, error) {
	verdicts.input = input
	if verdicts.err != nil {
		return tuttimodeexecutionservice.ReviewerVerdictResult{}, verdicts.err
	}
	return tuttimodeexecutionservice.ReviewerVerdictResult{
		ReviewID: input.ReviewID, Verdict: input.Verdict, Replayed: true,
	}, nil
}

type activeTurnStub struct {
	turnID string
	err    error
}

func (stub activeTurnStub) PersistedActiveTurnID(
	context.Context,
	string,
	string,
) (string, error) {
	return stub.turnID, stub.err
}

func TestProviderExposesExactlyOneVerdictCapability(t *testing.T) {
	commands := NewProvider(&recordingVerdicts{}, activeTurnStub{}).Commands()
	if len(commands) != 1 {
		t.Fatalf("commands = %#v, want verdict only", commands)
	}
	command := commands[0]
	if command.Capability.ID != "tutti-goal-review.goal-review.verdict" ||
		command.Capability.Visibility != cliservice.CapabilityVisibilityIntegration {
		t.Fatalf("verdict capability = %#v", command.Capability)
	}
	properties := command.Capability.InputSchema["properties"].(map[string]any)
	for _, name := range []string{
		"issue-id", "review-id", "checkpoint-id", "expected-graph-revision",
		"request-id", "verdict", "summary",
	} {
		if _, ok := properties[name]; !ok {
			t.Fatalf("verdict properties = %#v, missing %q", properties, name)
		}
	}
	for _, forbidden := range []string{"source-session-id", "review-session-id", "review-turn-id"} {
		if _, ok := properties[forbidden]; ok {
			t.Fatalf("verdict schema exposes untrusted identity %q: %#v", forbidden, properties)
		}
	}
	if !reflect.DeepEqual(properties["verdict"].(map[string]any)["enum"], []string{
		"goal_satisfied", "more_work_required", "inconclusive",
	}) {
		t.Fatalf("verdict enum = %#v", properties["verdict"])
	}
}

func TestRunVerdictDerivesTrustedSessionAndCanonicalActiveTurn(t *testing.T) {
	verdicts := &recordingVerdicts{}
	result, err := NewProvider(verdicts, activeTurnStub{turnID: " reviewer-turn "}).runVerdict(
		context.Background(),
		framework.InvokeContext{
			WorkspaceID: "workspace-1",
			Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
				AgentSessionID: " reviewer-session ",
			}},
		},
		verdictInput{
			IssueID: "issue-1", ReviewID: "review-1",
			CheckpointID: "checkpoint-goal", ExpectedGraphRevision: 9,
			RequestID: "verdict-1", Verdict: "inconclusive", Summary: "evidence",
		},
	)
	if err != nil {
		t.Fatalf("runVerdict() error = %v", err)
	}
	if verdicts.input.ReviewSessionID != "reviewer-session" ||
		verdicts.input.ReviewTurnID != "reviewer-turn" ||
		verdicts.input.WorkspaceID != "workspace-1" ||
		verdicts.input.IssueID != "issue-1" ||
		verdicts.input.ReviewID != "review-1" ||
		verdicts.input.CheckpointID != "checkpoint-goal" ||
		verdicts.input.ExpectedGraphRevision != 9 ||
		verdicts.input.RequestID != "verdict-1" ||
		verdicts.input.Verdict != "inconclusive" ||
		verdicts.input.Summary != "evidence" {
		t.Fatalf("verdict input = %#v", verdicts.input)
	}
	value := result.(map[string]any)
	if value["reviewId"] != "review-1" ||
		value["verdict"] != "inconclusive" ||
		value["replayed"] != true {
		t.Fatalf("verdict result = %#v", value)
	}
}

func TestRunVerdictRejectsMissingOrUnresolvableTrustedIdentity(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		session string
		turns   activeTurnStub
	}{
		{name: "missing session", turns: activeTurnStub{turnID: "turn-1"}},
		{name: "missing turn", session: "review-session"},
		{name: "turn lookup failure", session: "review-session", turns: activeTurnStub{err: errors.New("secret lookup failure")}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			verdicts := &recordingVerdicts{}
			_, err := NewProvider(verdicts, testCase.turns).runVerdict(
				context.Background(),
				framework.InvokeContext{
					WorkspaceID: "workspace-1",
					Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
						AgentSessionID: testCase.session,
					}},
				},
				verdictInput{
					IssueID: "issue-1", ReviewID: "review-1",
					CheckpointID: "checkpoint-goal", ExpectedGraphRevision: 9,
					RequestID: "verdict-identity", Verdict: "inconclusive", Summary: "evidence",
				},
			)
			if !errors.Is(err, cliservice.ErrInvalidInput) {
				t.Fatalf("identity error = %v", err)
			}
			if strings.Contains(err.Error(), "secret lookup failure") {
				t.Fatalf("identity error leaked lookup detail: %v", err)
			}
			if verdicts.input != (tuttimodeexecutionservice.ReviewerVerdictInput{}) {
				t.Fatalf("invalid identity reached service: %#v", verdicts.input)
			}
		})
	}
}

func TestRunVerdictMapsWrongIdentityAndProductErrorsWithoutLeaks(t *testing.T) {
	for _, contractErr := range []error{
		executionbiz.ErrExecutionNotFound,
		executionbiz.ErrExecutionConflict,
		executionbiz.ErrReviewerVerdictRejected,
		executionbiz.ErrReviewerVerdictMutationConflict,
	} {
		verdicts := &recordingVerdicts{err: fmt.Errorf("%w: secret review row", contractErr)}
		_, err := NewProvider(verdicts, activeTurnStub{turnID: "turn-1"}).runVerdict(
			context.Background(),
			framework.InvokeContext{
				WorkspaceID: "workspace-1",
				Request: cliservice.InvokeRequest{Context: cliservice.InvokeContext{
					AgentSessionID: "wrong-reviewer-session",
				}},
			},
			verdictInput{
				IssueID: "issue-1", ReviewID: "review-1",
				CheckpointID: "checkpoint-goal", ExpectedGraphRevision: 9,
				RequestID: "verdict-errors", Verdict: "inconclusive", Summary: "evidence",
			},
		)
		if !errors.Is(err, cliservice.ErrInvalidInput) ||
			strings.Contains(err.Error(), "secret review row") {
			t.Fatalf("verdict error %v mapped to %v", contractErr, err)
		}
	}
}
