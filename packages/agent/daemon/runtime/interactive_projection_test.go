package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestPendingInteractionTransitionProjectsSelfDescribingActions(t *testing.T) {
	t.Parallel()
	pending := &pendingInteractiveRequest{
		requestID: "request-1", turnID: "turn-1", kind: "approval", toolName: "Approval",
		options: []map[string]any{
			{"optionId": "approve", "name": "Approve", "kind": "allow_once"},
			{"optionId": "approve_for_session", "name": "Approve for session", "kind": "allow_always"},
			{"optionId": "deny", "name": "Deny", "kind": "reject_once"},
			{"optionId": "abort", "name": "Deny and stop", "kind": "reject_always"},
			{"optionId": "provider-specific", "label": "Provider specific", "kind": "custom"},
		},
	}
	transition := pendingInteractionTransition("turn-1", pending)
	actions, ok := transition.Metadata["actions"].([]any)
	if !ok || len(actions) != 5 {
		t.Fatalf("actions = %#v", transition.Metadata["actions"])
	}
	wantSemantics := []string{"approve", "approve_always", "deny", "deny_and_stop", ""}
	for index, want := range wantSemantics {
		action, ok := actions[index].(map[string]any)
		if !ok || action["semantic"] != want {
			t.Fatalf("action[%d] = %#v, want semantic %q", index, actions[index], want)
		}
		if action["id"] == "" || action["label"] == "" {
			t.Fatalf("action[%d] = %#v, want id and label", index, action)
		}
	}
}

func TestInteractiveApprovalOptionIDAcceptsActionFallback(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name  string
		input SubmitInteractiveInput
		want  string
	}{
		{name: "option wins", input: SubmitInteractiveInput{OptionID: "explicit", Action: "action", Payload: map[string]any{"optionId": "payload"}}, want: "explicit"},
		{name: "action fallback", input: SubmitInteractiveInput{Action: "approve"}, want: "approve"},
		{name: "payload fallback", input: SubmitInteractiveInput{Payload: map[string]any{"optionId": "deny"}}, want: "deny"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := interactiveApprovalOptionID(test.input); got != test.want {
				t.Fatalf("interactiveApprovalOptionID() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestCodexAndClaudeApprovalOptionsProjectSemantics(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name    string
		options []map[string]any
	}{
		{name: "codex", options: appServerApprovalOptions(appServerMethodCommandApproval)},
		{name: "claude-code", options: claudeSDKInteractiveOptions(nil, map[string]any{"name": "Bash"})},
	} {
		t.Run(test.name, func(t *testing.T) {
			actions := normalizedInteractionActions(test.options)
			if len(actions) == 0 {
				t.Fatal("actions are empty")
			}
			semantics := map[string]bool{}
			for _, raw := range actions {
				action := raw.(map[string]any)
				semantic, _ := action["semantic"].(string)
				if semantic == "" {
					t.Fatalf("action = %#v, want provider approval semantic", action)
				}
				semantics[semantic] = true
			}
			if !semantics["approve"] || !semantics["deny"] {
				t.Fatalf("semantics = %#v, want approve and deny", semantics)
			}
		})
	}
}

func TestPendingInteractiveRequestAllowsOnlyOnePendingToResolvingClaim(t *testing.T) {
	t.Parallel()
	pending := &pendingInteractiveRequest{requestID: "request-1"}

	type claimResult struct {
		state   pendingInteractiveRequestState
		claimed bool
	}
	results := make(chan claimResult, 2)
	for range 2 {
		go func() {
			state, claimed := pending.beginResolving()
			results <- claimResult{state: state, claimed: claimed}
		}()
	}
	first := <-results
	second := <-results
	claims := 0
	for _, result := range []claimResult{first, second} {
		if result.state != pendingInteractiveRequestStateResolving {
			t.Fatalf("claim state = %q, want resolving", result.state)
		}
		if result.claimed {
			claims++
		}
	}
	if claims != 1 {
		t.Fatalf("claims = [%#v %#v], want exactly one owner", first, second)
	}
	if pending.disposition() != pendingInteractiveRequestStateResolving {
		t.Fatalf("disposition = %q, want resolving", pending.disposition())
	}
	pending.finish(pendingInteractiveRequestStateAnswered)
	if state, err := pending.waitForDisposition(context.Background()); err != nil || state != pendingInteractiveRequestStateAnswered {
		t.Fatalf("terminal state=%q error=%v", state, err)
	}
	if state, claimed := pending.beginResolving(); claimed || state != pendingInteractiveRequestStateAnswered {
		t.Fatalf("terminal beginResolving = (%q, %v), want answered without claim", state, claimed)
	}
}

func TestPendingInteractiveRequestDispatchResponseIsAtomic(t *testing.T) {
	t.Parallel()
	pending := &pendingInteractiveRequest{
		requestID: "request-1",
		response:  make(chan pendingInteractiveResponse, 1),
	}

	type dispatchResult struct {
		state pendingInteractiveRequestState
		err   error
	}
	results := make(chan dispatchResult, 2)
	for _, optionID := range []string{"first", "second"} {
		go func() {
			state, err := pending.dispatchResponse(context.Background(), pendingInteractiveResponse{optionID: optionID})
			results <- dispatchResult{state: state, err: err}
		}()
	}

	first := <-results
	second := <-results
	successes := 0
	for _, result := range []dispatchResult{first, second} {
		if result.err == nil {
			successes++
			if result.state != pendingInteractiveRequestStateResolving {
				t.Fatalf("successful dispatch state = %q, want resolving", result.state)
			}
		}
	}
	if successes != 1 {
		t.Fatalf("dispatch results = [%#v %#v], want exactly one success", first, second)
	}
	if len(pending.response) != 1 {
		t.Fatalf("response channel length = %d, want 1", len(pending.response))
	}
}

func TestPendingInteractiveRequestCanceledDispatchRemainsPending(t *testing.T) {
	t.Parallel()
	pending := &pendingInteractiveRequest{
		requestID: "request-1",
		response:  make(chan pendingInteractiveResponse, 1),
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	state, err := pending.dispatchResponse(ctx, pendingInteractiveResponse{optionID: "allow"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("dispatch error = %v, want context canceled", err)
	}
	if state != pendingInteractiveRequestStatePending || pending.disposition() != pendingInteractiveRequestStatePending {
		t.Fatalf("state = %q disposition = %q, want pending", state, pending.disposition())
	}
	if len(pending.response) != 0 {
		t.Fatalf("response channel length = %d, want 0", len(pending.response))
	}
}

func TestPendingInteractiveRequestReleaseResolvingDoesNotOverwriteTerminal(t *testing.T) {
	t.Parallel()
	pending := &pendingInteractiveRequest{requestID: "request-1"}
	if _, claimed := pending.beginResolving(); !claimed {
		t.Fatal("beginResolving did not claim pending request")
	}
	if !pending.releaseResolving() || pending.disposition() != pendingInteractiveRequestStatePending {
		t.Fatalf("release disposition = %q, want pending", pending.disposition())
	}
	if _, claimed := pending.beginResolving(); !claimed {
		t.Fatal("beginResolving did not reclaim released request")
	}
	pending.finish(pendingInteractiveRequestStateSuperseded)
	if pending.releaseResolving() {
		t.Fatal("releaseResolving overwrote terminal state")
	}
	if pending.disposition() != pendingInteractiveRequestStateSuperseded {
		t.Fatalf("terminal disposition = %q, want superseded", pending.disposition())
	}
}

func TestPendingInteractiveRequestSupersedeUnblocksProviderWaiter(t *testing.T) {
	t.Parallel()
	pending := &pendingInteractiveRequest{
		requestID: "request-1",
		response:  make(chan pendingInteractiveResponse, 1),
	}
	result := make(chan error, 1)
	go func() {
		_, err := pending.wait(context.Background())
		result <- err
	}()

	pending.supersede(errPermissionRequestCanceled)

	select {
	case err := <-result:
		if !errors.Is(err, errPermissionRequestCanceled) {
			t.Fatalf("wait error = %v, want permission request canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("terminal request left provider waiter blocked")
	}
}

func TestTerminalInteractiveDispositionStoreUsesFullIdentityAndIsBounded(t *testing.T) {
	t.Parallel()
	store := terminalInteractiveDispositionStore{}
	store.put(newInteractiveRequestKey("session-1", "turn-1", "request-1"), InteractiveDispositionAnswered)
	store.put(newInteractiveRequestKey("session-1", "turn-1", "request-1"), InteractiveDispositionSuperseded)
	store.put(newInteractiveRequestKey("session-1", "turn-2", "request-1"), InteractiveDispositionSuperseded)
	if got := store.get(newInteractiveRequestKey("session-1", "turn-1", "request-1")); got != InteractiveDispositionAnswered {
		t.Fatalf("turn-1 disposition = %q, want answered", got)
	}
	if got := store.get(newInteractiveRequestKey("session-1", "turn-2", "request-1")); got != InteractiveDispositionSuperseded {
		t.Fatalf("turn-2 disposition = %q, want superseded", got)
	}
	for index := 0; index < terminalInteractiveDispositionCapacity; index++ {
		store.put(newInteractiveRequestKey("session-2", "turn", fmt.Sprintf("request-%d", index)), InteractiveDispositionAnswered)
	}
	if len(store.entries) != terminalInteractiveDispositionCapacity {
		t.Fatalf("terminal entries = %d, want %d", len(store.entries), terminalInteractiveDispositionCapacity)
	}
	if got := store.get(newInteractiveRequestKey("session-1", "turn-1", "request-1")); got != InteractiveDispositionUnknown {
		t.Fatalf("oldest disposition = %q, want bounded eviction", got)
	}
}
