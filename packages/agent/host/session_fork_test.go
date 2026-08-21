package agenthost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestGetSessionForkOperationReconcilesLocalCommitAfterProviderAcceptance(t *testing.T) {
	store := newFakeSessionForkStore()
	store.failCommit = true
	runtime := &fakeSessionForkRuntime{providerSessionID: "provider-child"}
	host := New(Config{SessionForks: store, SessionForkRuntime: runtime})
	input := ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	}
	first, err := host.ForkSession(context.Background(), input)
	if err == nil || first.Operation.Status != storesqlite.SessionForkStatusProviderAccepted {
		t.Fatalf("first ForkSession() result=%#v error=%v", first, err)
	}
	if runtime.forkCalls != 1 {
		t.Fatalf("provider fork calls=%d, want 1", runtime.forkCalls)
	}
	store.failCommit = false
	second, found, err := host.GetSessionForkOperation(
		context.Background(), "ws", first.Operation.OperationID,
	)
	if !found {
		t.Fatal("GetSessionForkOperation() found=false, want true")
	}
	if err != nil || second.Operation.Status != storesqlite.SessionForkStatusCommitted {
		t.Fatalf("GetSessionForkOperation() result=%#v error=%v", second, err)
	}
	if runtime.forkCalls != 1 {
		t.Fatalf("provider fork calls after GET reconciliation=%d, want 1", runtime.forkCalls)
	}
}

func TestForkSessionRepairsMissingProviderBindingFromOpaqueSubmitClaim(t *testing.T) {
	store := &recoverableSessionForkStore{
		fakeSessionForkStore: newFakeSessionForkStore(),
		claim: storesqlite.SubmitClaim{
			WorkspaceID: "ws", AgentSessionID: "source", TurnID: "turn",
			ClientSubmitID: "opaque-submit-1",
		},
	}
	store.boundaryUnsupported = true
	store.boundaryReason = storesqlite.SessionForkBoundaryReasonProviderTurnMissing
	runtime := &recoverableSessionForkRuntime{
		fakeSessionForkRuntime: fakeSessionForkRuntime{
			providerSessionID: "provider-child",
		},
	}
	canonical := turnReadCanonicalStore{
		turn: storesqlite.Turn{
			WorkspaceID: "ws", AgentSessionID: "source", TurnID: "turn",
			Phase: storesqlite.TurnPhaseSettled,
		},
	}
	host := New(Config{
		CanonicalStore: canonical, SessionForks: store,
		SessionForkRuntime: runtime,
	})
	result, err := host.ForkSession(t.Context(), ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	})
	if err != nil || result.Operation.Status != storesqlite.SessionForkStatusCommitted {
		t.Fatalf("ForkSession() result=%#v error=%v", result, err)
	}
	if runtime.recoveryInput.RecoveryToken != "opaque-submit-1" ||
		runtime.recoveryInput.CanonicalTurnID != "turn" ||
		store.recovery.ProviderTurnID != "provider-turn" ||
		store.checkCalls != 3 {
		t.Fatalf(
			"recovery runtime=%#v store=%#v checks=%d",
			runtime.recoveryInput,
			store.recovery,
			store.checkCalls,
		)
	}
}

func TestForkSessionRepairsBindingRejectedByOwningAgent(t *testing.T) {
	store := &recoverableSessionForkStore{
		fakeSessionForkStore: newFakeSessionForkStore(),
		claim: storesqlite.SubmitClaim{
			WorkspaceID: "ws", AgentSessionID: "source", TurnID: "turn",
			ClientSubmitID: "opaque-submit-1",
		},
	}
	runtime := &recoverableSessionForkRuntime{
		fakeSessionForkRuntime: fakeSessionForkRuntime{
			providerSessionID: "provider-child",
		},
		forkability: []bool{false, true},
	}
	canonical := turnReadCanonicalStore{
		turn: storesqlite.Turn{
			WorkspaceID: "ws", AgentSessionID: "source", TurnID: "turn",
			Phase:                        storesqlite.TurnPhaseSettled,
			RootProviderTurnID:           "provider-turn",
			ProviderTurnBindingJSON:      json.RawMessage(`{"schemaVersion":1}`),
			ProviderForkBindingAvailable: false,
		},
	}
	host := New(Config{
		CanonicalStore: canonical, SessionForks: store,
		SessionForkRuntime: runtime,
	})

	result, err := host.ForkSession(t.Context(), ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	})
	if err != nil || result.Operation.Status != storesqlite.SessionForkStatusCommitted {
		t.Fatalf("ForkSession() result=%#v error=%v", result, err)
	}
	if runtime.forkabilityCalls != 2 {
		t.Fatalf("forkability hook calls=%d, want 2", runtime.forkabilityCalls)
	}
	if store.recovery.ProviderTurnID != "provider-turn" {
		t.Fatalf("recovery=%#v", store.recovery)
	}
}

func TestForkSessionBindingRecoveryFailureKeepsStableBoundaryReason(t *testing.T) {
	store := newFakeSessionForkStore()
	store.boundaryUnsupported = true
	store.boundaryReason = storesqlite.SessionForkBoundaryReasonProviderTurnMissing
	host := New(Config{
		SessionForks:       store,
		SessionForkRuntime: &fakeSessionForkRuntime{},
	})

	_, err := host.ForkSession(t.Context(), ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	})
	if !errors.Is(err, storesqlite.ErrSessionForkTurnState) {
		t.Fatalf("ForkSession() error=%v, want boundary conflict", err)
	}
	var reasoner interface{ ForkBoundaryReason() string }
	if !errors.As(err, &reasoner) ||
		reasoner.ForkBoundaryReason() !=
			string(storesqlite.SessionForkBoundaryReasonProviderTurnMissing) {
		t.Fatalf("ForkSession() boundary reason=%v", err)
	}
	if strings.Contains(err.Error(), "recover provider turn binding") {
		t.Fatalf("ForkSession() leaked recovery diagnostic: %v", err)
	}
}

func TestForkSessionTransportFailureBecomesUnknownAndNeverRedispatches(t *testing.T) {
	store := newFakeSessionForkStore()
	runtime := &fakeSessionForkRuntime{forkErr: errors.New("connection lost")}
	host := New(Config{SessionForks: store, SessionForkRuntime: runtime})
	input := ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	}
	first, err := host.ForkSession(context.Background(), input)
	if !errors.Is(err, ErrSessionForkDeliveryUnknown) ||
		first.Operation.Status != storesqlite.SessionForkStatusUnknown {
		t.Fatalf("first ForkSession() result=%#v error=%v", first, err)
	}
	second, err := host.ForkSession(context.Background(), input)
	if !errors.Is(err, ErrSessionForkDeliveryUnknown) ||
		second.Operation.Status != storesqlite.SessionForkStatusUnknown {
		t.Fatalf("second ForkSession() result=%#v error=%v", second, err)
	}
	if runtime.forkCalls != 1 {
		t.Fatalf("provider fork calls=%d, want 1", runtime.forkCalls)
	}

	differentIdentity := input
	differentIdentity.RequestID = "request-after-restart"
	differentIdentity.TargetAgentSessionID = "target-after-restart"
	third, err := host.ForkSession(context.Background(), differentIdentity)
	if !errors.Is(err, ErrSessionForkDeliveryUnknown) ||
		third.Operation.OperationID != first.Operation.OperationID ||
		third.Operation.RequestID != first.Operation.RequestID ||
		third.Operation.TargetAgentSessionID != first.Operation.TargetAgentSessionID {
		t.Fatalf("different-identity replay result=%#v error=%v", third, err)
	}
	if runtime.forkCalls != 1 {
		t.Fatalf("provider fork calls after recovered identity=%d, want 1", runtime.forkCalls)
	}
}

func TestForkSessionBindsAcceptedProviderStateBeforeCanonicalCommit(t *testing.T) {
	store := newFakeSessionForkStore()
	runtime := &fakeSessionForkRuntime{
		providerSessionID: "provider-child",
		stateBindingMode:  SessionForkStateBindingHostCopy,
	}
	binder := &fakeSessionForkStateBinder{}
	host := New(Config{
		SessionForks: store, SessionForkRuntime: runtime, SessionForkState: binder,
	})
	result, err := host.ForkSession(t.Context(), ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	})
	if err != nil || result.Operation.Status != storesqlite.SessionForkStatusCommitted {
		t.Fatalf("ForkSession() result=%#v error=%v", result, err)
	}
	if len(binder.inputs) != 1 {
		t.Fatalf("provider state binding calls=%d, want 1", len(binder.inputs))
	}
	want := SessionForkProviderStateBinding{
		WorkspaceID:             "ws",
		Provider:                "codex",
		SourceAgentSessionID:    "source",
		TargetAgentSessionID:    "target",
		SourceProviderSessionID: "provider-source",
		TargetProviderSessionID: "provider-child",
	}
	if !reflect.DeepEqual(binder.inputs[0], want) {
		t.Fatalf("provider state binding=%#v, want %#v", binder.inputs[0], want)
	}
}

func TestForkSessionProviderStateBindingFailureRetainsAcceptedChildAndRetriesBinding(t *testing.T) {
	store := newFakeSessionForkStore()
	runtime := &fakeSessionForkRuntime{
		providerSessionID: "provider-child",
		stateBindingMode:  SessionForkStateBindingHostCopy,
	}
	binder := &fakeSessionForkStateBinder{err: errors.New("rollout copy failed")}
	host := New(Config{
		SessionForks: store, SessionForkRuntime: runtime, SessionForkState: binder,
	})
	input := ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	}
	first, err := host.ForkSession(t.Context(), input)
	if err == nil ||
		first.Operation.Status != storesqlite.SessionForkStatusProviderAccepted {
		t.Fatalf("first ForkSession() result=%#v error=%v", first, err)
	}
	if first.Operation.TargetProviderSessionID != "provider-child" {
		t.Fatalf(
			"accepted operation target provider session=%q, want provider-child",
			first.Operation.TargetProviderSessionID,
		)
	}
	if first.Session.ID != "" {
		t.Fatalf("canonical child was committed after binding failure: %#v", first.Session)
	}
	binder.err = nil
	second, err := host.ForkSession(t.Context(), input)
	if err != nil ||
		second.Operation.Status != storesqlite.SessionForkStatusCommitted {
		t.Fatalf("second ForkSession() result=%#v error=%v", second, err)
	}
	if runtime.forkCalls != 1 || len(binder.inputs) != 2 {
		t.Fatalf(
			"retry calls provider=%d binder=%d, want 1/2",
			runtime.forkCalls,
			len(binder.inputs),
		)
	}
}

func TestForkSessionHostCopyWithoutBinderFailsClosed(t *testing.T) {
	store := newFakeSessionForkStore()
	runtime := &fakeSessionForkRuntime{
		providerSessionID: "provider-child",
		stateBindingMode:  SessionForkStateBindingHostCopy,
	}
	result, err := New(Config{
		SessionForks: store, SessionForkRuntime: runtime,
	}).ForkSession(t.Context(), ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	})
	if !errors.Is(err, ErrSessionForkUnsupported) ||
		result.Operation.OperationID != "" ||
		result.Session.ID != "" ||
		runtime.forkCalls != 0 {
		t.Fatalf("ForkSession() result=%#v error=%v", result, err)
	}
}

func TestForkSessionHostCopyWithUnsupportedBinderFailsBeforeDispatch(t *testing.T) {
	store := newFakeSessionForkStore()
	runtime := &fakeSessionForkRuntime{
		providerSessionID: "provider-child",
		stateBindingMode:  SessionForkStateBindingHostCopy,
	}
	result, err := New(Config{
		SessionForks:       store,
		SessionForkRuntime: runtime,
		SessionForkState:   &fakeSessionForkStateBinder{unsupported: true},
	}).ForkSession(t.Context(), ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	})
	if !errors.Is(err, ErrSessionForkUnsupported) ||
		result.Operation.OperationID != "" ||
		runtime.forkCalls != 0 {
		t.Fatalf("ForkSession() result=%#v error=%v", result, err)
	}
}

func TestForkSessionLostCommittedResponseRecoversBeforeAcknowledgedNewBranch(t *testing.T) {
	store := newFakeSessionForkStore()
	runtime := &fakeSessionForkRuntime{providerSessionID: "provider-child"}
	host := New(Config{SessionForks: store, SessionForkRuntime: runtime})
	first, err := host.ForkSession(t.Context(), ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	})
	if err != nil || first.Operation.Status != storesqlite.SessionForkStatusCommitted {
		t.Fatalf("first ForkSession() result=%#v error=%v", first, err)
	}
	recovered, err := host.ForkSession(t.Context(), ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target-after-restart",
		RequestID:            "request-after-restart",
		Point: SessionForkPoint{
			Kind: SessionForkPointThroughTurn, TurnID: "turn",
		},
	})
	if err != nil ||
		recovered.Operation.OperationID != first.Operation.OperationID ||
		recovered.Operation.RequestID != "request" ||
		recovered.Operation.TargetAgentSessionID != "target" ||
		recovered.Session.ID != "target" ||
		runtime.forkCalls != 1 {
		t.Fatalf(
			"lost-response recovery result=%#v providerCalls=%d error=%v",
			recovered,
			runtime.forkCalls,
			err,
		)
	}
	if _, found, err := host.AcknowledgeSessionForkOperation(
		t.Context(),
		"ws",
		first.Operation.OperationID,
	); err != nil || !found {
		t.Fatalf("AcknowledgeSessionForkOperation() found=%v error=%v", found, err)
	}
	next, err := host.ForkSession(t.Context(), ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target-next", RequestID: "request-next",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	})
	if err != nil || next.Operation.RequestID != "request-next" ||
		next.Operation.TargetAgentSessionID != "target-next" ||
		runtime.forkCalls != 2 {
		t.Fatalf(
			"post-ack ForkSession() result=%#v providerCalls=%d error=%v",
			next,
			runtime.forkCalls,
			err,
		)
	}
}

func TestGetSessionForkOperationRetainsPreparedOperationForSafeDispatch(t *testing.T) {
	store := newFakeSessionForkStore()
	store.operation = storesqlite.SessionForkOperation{
		OperationID: "operation", WorkspaceID: "ws", RequestID: "request",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target",
		SourceTurnID: "turn", Status: storesqlite.SessionForkStatusPrepared,
	}
	runtime := &fakeSessionForkRuntime{providerSessionID: "provider-child"}
	host := New(Config{SessionForks: store, SessionForkRuntime: runtime})

	result, found, err := host.GetSessionForkOperation(
		t.Context(), "ws", "operation",
	)
	if err != nil || !found {
		t.Fatalf("GetSessionForkOperation() found=%v error=%v", found, err)
	}
	if result.Operation.Status != storesqlite.SessionForkStatusPrepared {
		t.Fatalf("operation status=%q, want prepared", result.Operation.Status)
	}
	if runtime.resolveCalls != 0 || runtime.forkCalls != 0 {
		t.Fatalf(
			"runtime calls resolve=%d fork=%d, want zero",
			runtime.resolveCalls,
			runtime.forkCalls,
		)
	}
}

func TestGetSessionForkOperationDoesNotMisclassifyLiveDispatch(t *testing.T) {
	store := newFakeSessionForkStore()
	store.operation = storesqlite.SessionForkOperation{
		OperationID: "operation", WorkspaceID: "ws", RequestID: "request",
		SourceAgentSessionID: "source", TargetAgentSessionID: "target",
		SourceTurnID: "turn", Status: storesqlite.SessionForkStatusDispatching,
	}
	runtime := &fakeSessionForkRuntime{providerSessionID: "provider-child"}
	host := New(Config{SessionForks: store, SessionForkRuntime: runtime})

	result, found, err := host.GetSessionForkOperation(
		t.Context(), "ws", "operation",
	)
	if err != nil || !found {
		t.Fatalf("GetSessionForkOperation() found=%v error=%v", found, err)
	}
	if result.Operation.Status != storesqlite.SessionForkStatusDispatching {
		t.Fatalf("operation status=%q, want dispatching", result.Operation.Status)
	}
	if runtime.resolveCalls != 0 || runtime.forkCalls != 0 {
		t.Fatalf(
			"runtime calls resolve=%d fork=%d, want zero",
			runtime.resolveCalls,
			runtime.forkCalls,
		)
	}
}

func TestForkSessionExplicitProviderRejectionFailsAndReleasesReservation(t *testing.T) {
	store := newFakeSessionForkStore()
	runtime := &fakeSessionForkRuntime{
		forkDisposition: SessionForkDeliveryRejected,
		forkErr:         errors.New("invalid lastTurnId"),
	}
	host := New(Config{SessionForks: store, SessionForkRuntime: runtime})
	input := ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	}
	result, err := host.ForkSession(context.Background(), input)
	if !errors.Is(err, ErrSessionForkFailed) ||
		result.Operation.Status != storesqlite.SessionForkStatusFailed {
		t.Fatalf("ForkSession() result=%#v error=%v", result, err)
	}
	if runtime.forkCalls != 1 {
		t.Fatalf("provider fork calls=%d, want 1", runtime.forkCalls)
	}
}

func TestForkSessionRequiresAcceptedDeliveryDisposition(t *testing.T) {
	tests := []struct {
		name        string
		disposition SessionForkDeliveryDisposition
		providerID  string
		wantStatus  string
	}{
		{
			name: "accepted", disposition: SessionForkDeliveryAccepted,
			providerID: "provider-child", wantStatus: storesqlite.SessionForkStatusCommitted,
		},
		{
			name: "not started", disposition: SessionForkDeliveryNotStarted,
			providerID: "provider-child", wantStatus: storesqlite.SessionForkStatusFailed,
		},
		{
			name: "rejected", disposition: SessionForkDeliveryRejected,
			providerID: "provider-child", wantStatus: storesqlite.SessionForkStatusFailed,
		},
		{
			name: "unknown", disposition: SessionForkDeliveryUnknown,
			providerID: "provider-child", wantStatus: storesqlite.SessionForkStatusUnknown,
		},
		{
			name:       "missing disposition",
			providerID: "provider-child", wantStatus: storesqlite.SessionForkStatusUnknown,
		},
		{
			name: "accepted without child id", disposition: SessionForkDeliveryAccepted,
			wantStatus: storesqlite.SessionForkStatusUnknown,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newFakeSessionForkStore()
			runtime := &fakeSessionForkRuntime{
				providerSessionID:   test.providerID,
				forkDisposition:     test.disposition,
				preserveDisposition: true,
			}
			host := New(Config{SessionForks: store, SessionForkRuntime: runtime})
			result, _ := host.ForkSession(t.Context(), ForkSessionInput{
				WorkspaceID: "ws", SourceAgentSessionID: "source",
				TargetAgentSessionID: "target", RequestID: "request",
				Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
			})
			if result.Operation.Status != test.wantStatus {
				t.Fatalf(
					"operation status=%q, want %q",
					result.Operation.Status,
					test.wantStatus,
				)
			}
			if runtime.forkCalls != 1 {
				t.Fatalf("provider fork calls=%d, want 1", runtime.forkCalls)
			}
		})
	}
}

func TestRecoverSessionForksMarksDispatchingUnknownWithoutProviderCall(t *testing.T) {
	store := newFakeSessionForkStore()
	store.operation = storesqlite.SessionForkOperation{
		OperationID: "operation", WorkspaceID: "ws", RequestID: "request",
		RequestHash: "hash", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", SourceTurnID: "turn",
		SourceProviderSessionID: "provider-source",
		SourceProviderTurnID:    "provider-turn", DriverKind: "codex",
		DriverVersion: "1", Status: storesqlite.SessionForkStatusDispatching,
	}
	runtime := &fakeSessionForkRuntime{providerSessionID: "provider-child"}
	host := New(Config{
		SessionForks: store, SessionForkRecovery: store, SessionForkRuntime: runtime,
	})
	if err := host.RecoverSessionForks(context.Background()); err != nil {
		t.Fatalf("RecoverSessionForks() error=%v", err)
	}
	if store.operation.Status != storesqlite.SessionForkStatusUnknown {
		t.Fatalf("recovered status=%q, want unknown", store.operation.Status)
	}
	if runtime.forkCalls != 0 {
		t.Fatalf("provider fork calls=%d, want 0", runtime.forkCalls)
	}
}

func TestRecoverSessionForksNeverRedispatchesIndeterminateProviderDelivery(t *testing.T) {
	for _, status := range []string{
		storesqlite.SessionForkStatusDispatching,
		storesqlite.SessionForkStatusUnknown,
	} {
		t.Run(status, func(t *testing.T) {
			store := newFakeSessionForkStore()
			store.operation = storesqlite.SessionForkOperation{
				OperationID: "11111111-1111-4111-8111-111111111111",
				WorkspaceID: "ws", RequestID: "request", RequestHash: "hash",
				SourceAgentSessionID: "source", TargetAgentSessionID: "target",
				SourceTurnID: "turn", SourceProviderSessionID: "provider-source",
				SourceProviderTurnID: "provider-turn",
				DriverKind:           "claude", DriverVersion: "deterministic-v1",
				Status: status,
			}
			runtime := &fakeSessionForkRuntime{
				providerSessionID: store.operation.OperationID,
				descriptors: []SessionForkDriverDescriptor{{
					Kind: "claude", Version: "deterministic-v1",
					StateBindingMode: SessionForkStateBindingProviderOwned,
					ThroughTurn:      true,
				}},
			}
			host := New(Config{
				SessionForks: store, SessionForkRecovery: store,
				SessionForkRuntime: runtime,
			})
			if err := host.RecoverSessionForks(context.Background()); err != nil {
				t.Fatalf("RecoverSessionForks() error=%v", err)
			}
			if store.operation.Status != storesqlite.SessionForkStatusUnknown {
				t.Fatalf("recovered status=%q, want unknown", store.operation.Status)
			}
			if runtime.forkCalls != 0 || len(runtime.forkInputs) != 0 {
				t.Fatalf("provider fork calls=%d inputs=%#v", runtime.forkCalls, runtime.forkInputs)
			}
		})
	}
}

func TestRecoverSessionForksFailsPreparedOperationBeforeProviderWhenRuntimeCannotRecover(t *testing.T) {
	store := newFakeSessionForkStore()
	store.operation = storesqlite.SessionForkOperation{
		OperationID: "operation", WorkspaceID: "ws", RequestID: "request",
		RequestHash: "hash", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", SourceTurnID: "turn",
		SourceProviderSessionID: "provider-source",
		SourceProviderTurnID:    "provider-turn", DriverKind: "codex",
		DriverVersion: "1", Status: storesqlite.SessionForkStatusPrepared,
	}
	runtime := &fakeSessionForkRuntime{
		resolveErr: errors.New("runtime is intentionally not live during recovery"),
	}
	host := New(Config{
		SessionForks: store, SessionForkRecovery: store, SessionForkRuntime: runtime,
	})
	if err := host.RecoverSessionForks(context.Background()); err == nil {
		t.Fatal("RecoverSessionForks() error=nil, want runtime recovery failure")
	}
	if store.operation.Status != storesqlite.SessionForkStatusFailed {
		t.Fatalf("recovered status=%q, want failed", store.operation.Status)
	}
	if runtime.resolveCalls != 1 || runtime.forkCalls != 0 {
		t.Fatalf("runtime calls resolve=%d fork=%d, want 1/0", runtime.resolveCalls, runtime.forkCalls)
	}
}

func TestRecoverSessionForksConsumesEveryStableCursorPage(t *testing.T) {
	store := &pagedSessionForkRecoveryStore{
		failed: make(map[string]bool),
	}
	for index := 0; index < 205; index++ {
		store.operations = append(store.operations, storesqlite.SessionForkOperation{
			OperationID: fmt.Sprintf("operation-%03d", index),
			WorkspaceID: "ws", SourceAgentSessionID: fmt.Sprintf("source-%03d", index),
			TargetAgentSessionID: fmt.Sprintf("target-%03d", index),
			CreatedAtUnixMS:      100,
			Status:               storesqlite.SessionForkStatusUnknown,
		})
	}
	host := New(Config{
		SessionForks: store, SessionForkRecovery: store,
		SessionForkRuntime: &fakeSessionForkRuntime{},
	})
	if err := host.RecoverSessionForks(context.Background()); err != nil {
		t.Fatalf("RecoverSessionForks() error=%v", err)
	}
	if len(store.failed) != 0 {
		t.Fatalf("failed operations=%d, want 0", len(store.failed))
	}
}

func TestForkSessionPersistsProviderAcceptanceAfterCallerCancellation(t *testing.T) {
	store := newFakeSessionForkStore()
	ctx, cancel := context.WithCancel(context.Background())
	runtime := &fakeSessionForkRuntime{
		providerSessionID: "provider-child",
		onFork:            cancel,
	}
	host := New(Config{SessionForks: store, SessionForkRuntime: runtime})
	result, err := host.ForkSession(ctx, ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	})
	if err != nil {
		t.Fatalf("ForkSession() error=%v", err)
	}
	if result.Operation.Status != storesqlite.SessionForkStatusCommitted {
		t.Fatalf("operation status=%q, want committed", result.Operation.Status)
	}
	if store.operation.TargetProviderSessionID != "provider-child" {
		t.Fatalf("accepted provider session=%q", store.operation.TargetProviderSessionID)
	}
}

func TestForkSessionFailsPreparedOperationWhenDriverChangesBeforeDispatch(t *testing.T) {
	store := newFakeSessionForkStore()
	runtime := &fakeSessionForkRuntime{
		descriptors: []SessionForkDriverDescriptor{
			{Kind: "codex", Version: "1", ThroughTurn: true},
			{Kind: "codex", Version: "2", ThroughTurn: true},
		},
	}
	host := New(Config{SessionForks: store, SessionForkRuntime: runtime})
	result, err := host.ForkSession(context.Background(), ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	})
	if !errors.Is(err, ErrSessionForkUnsupported) {
		t.Fatalf("ForkSession() error=%v, want unsupported", err)
	}
	if result.Operation.Status != storesqlite.SessionForkStatusFailed {
		t.Fatalf("operation status=%q, want failed", result.Operation.Status)
	}
	if runtime.forkCalls != 0 {
		t.Fatalf("provider fork calls=%d, want zero", runtime.forkCalls)
	}
}

func TestGetSessionForkCapabilitiesUsesPersistedHistoricalAttestation(t *testing.T) {
	store := newFakeSessionForkStore()
	store.source = storesqlite.Session{
		ID: "source", WorkspaceID: "ws", UserID: "user", Kind: storesqlite.SessionKindRoot,
		AgentTargetID: "target", Provider: "codex", ProviderSessionID: "provider-source",
		Cwd: "/canonical", InternalRuntimeContext: map[string]any{"origin": "canonical"},
		Settings: map[string]any{"model": "canonical-model", "permissionModeId": "canonical-mode"},
	}
	preparation := &fakeSessionForkPreparation{prepared: PreparedRuntime{
		Cwd: "/prepared", Env: []string{"FORK_ENV=prepared"},
		ProviderTargetRef: map[string]any{"target": "prepared"},
		RuntimeContext:    map[string]any{"origin": "prepared"},
		Settings: &ComposerSettings{
			Model: "prepared-model", PermissionModeID: "prepared-mode",
		},
	}}
	runtime := &fakeSessionForkRuntime{}
	host := New(Config{
		SessionForks: store, SessionForkRuntime: runtime,
		RuntimePreparation: preparation,
	})

	capabilities, err := host.GetSessionForkCapabilities(t.Context(), SessionForkCapabilityInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
	})
	if err != nil {
		t.Fatalf("GetSessionForkCapabilities() error=%v", err)
	}
	if !capabilities.ThroughTurn {
		t.Fatal("GetSessionForkCapabilities() ThroughTurn=false, want true")
	}
	if len(preparation.inputs) != 0 {
		t.Fatalf("preparation calls=%d, want 0", len(preparation.inputs))
	}
	if len(runtime.resolvedSources) != 1 {
		t.Fatalf("resolved sources=%d, want 1", len(runtime.resolvedSources))
	}
	resolved := runtime.resolvedSources[0]
	if resolved.ID != "source" ||
		resolved.ProviderSessionID != "provider-source" ||
		resolved.Cwd != "/canonical" ||
		resolved.Settings == nil ||
		resolved.Settings.Model != "canonical-model" ||
		!reflect.DeepEqual(
			resolved.RuntimeContext,
			map[string]any{"origin": "canonical"},
		) {
		t.Fatalf("resolved persisted source=%#v", resolved)
	}
}

func TestGetSessionForkCapabilitiesDoesNotReadHistoricalProviderPrefix(t *testing.T) {
	store := newFakeSessionForkStore()
	store.turnIdentities = []storesqlite.SessionForkTurnIdentity{
		{TurnID: "turn-1", ProviderTurnID: "provider-turn-1", Phase: storesqlite.TurnPhaseSettled},
		{TurnID: "turn-2", ProviderTurnID: "provider-turn-2", Phase: storesqlite.TurnPhaseSettled},
		{TurnID: "turn-stale", ProviderTurnID: "provider-turn-stale", Phase: storesqlite.TurnPhaseSettled},
		{TurnID: "turn-3", ProviderTurnID: "provider-turn-3", Phase: storesqlite.TurnPhaseSettled},
	}
	runtime := &fakeSessionForkRuntime{descriptors: []SessionForkDriverDescriptor{{
		Kind: "codex", Version: "1", ThroughTurn: true,
	}}}
	host := New(Config{SessionForks: store, SessionForkRuntime: runtime})

	capabilities, err := host.GetSessionForkCapabilities(
		t.Context(),
		SessionForkCapabilityInput{
			WorkspaceID: "ws", SourceAgentSessionID: "source",
		},
	)
	if err != nil {
		t.Fatalf("GetSessionForkCapabilities() error=%v", err)
	}
	if !capabilities.ThroughTurn {
		t.Fatalf("capabilities=%#v, want driver through-turn capability", capabilities)
	}
	if store.listTurnIdentityCalls != 0 {
		t.Fatalf("turn identity reads=%d, want 0", store.listTurnIdentityCalls)
	}
}

func TestForkSessionReusesOnePreparedHistoricalIdentityThroughDispatch(t *testing.T) {
	store := newFakeSessionForkStore()
	store.source = storesqlite.Session{
		ID: "source", WorkspaceID: "ws", Kind: storesqlite.SessionKindRoot,
		AgentTargetID: "target", Provider: "codex", ProviderSessionID: "provider-source",
		Cwd: "/canonical", InternalRuntimeContext: map[string]any{"origin": "canonical"},
		Settings: map[string]any{"model": "canonical-model"},
	}
	preparation := &fakeSessionForkPreparation{prepared: PreparedRuntime{
		Cwd: "/prepared", Env: []string{"FORK_ENV=prepared"},
		ProviderTargetRef: map[string]any{"target": "prepared"},
		RuntimeContext:    map[string]any{"origin": "prepared"},
		Settings:          &ComposerSettings{Model: "prepared-model"},
	}}
	runtime := &fakeSessionForkRuntime{
		providerSessionID:  "provider-child",
		mutateFirstResolve: true,
	}
	host := New(Config{
		SessionForks: store, SessionForkRuntime: runtime,
		RuntimePreparation: preparation,
	})

	result, err := host.ForkSession(t.Context(), ForkSessionInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
		TargetAgentSessionID: "target-session", RequestID: "request",
		Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
	})
	if err != nil {
		t.Fatalf("ForkSession() error=%v", err)
	}
	if result.Operation.Status != storesqlite.SessionForkStatusCommitted {
		t.Fatalf("operation status=%q, want committed", result.Operation.Status)
	}
	if len(preparation.inputs) != 1 {
		t.Fatalf("preparation calls=%d, want 1", len(preparation.inputs))
	}
	if len(runtime.resolvedSources) != 2 {
		t.Fatalf("resolved sources=%d, want 2", len(runtime.resolvedSources))
	}
	if len(runtime.forkInputs) != 1 {
		t.Fatalf("fork inputs=%d, want 1", len(runtime.forkInputs))
	}
	if runtime.forkInputs[0].SourceProviderTurnID != "provider-turn" {
		t.Fatalf(
			"provider turn=%q, want provider-turn",
			runtime.forkInputs[0].SourceProviderTurnID,
		)
	}
	assertPreparedForkSource(t, runtime.resolvedSources[0])
	if !reflect.DeepEqual(runtime.resolvedSources[0], runtime.resolvedSources[1]) ||
		!reflect.DeepEqual(runtime.resolvedSources[0], runtime.forkInputs[0].Source) {
		t.Fatalf(
			"prepared identity drifted: capability=%#v dispatch-check=%#v fork=%#v",
			runtime.resolvedSources[0],
			runtime.resolvedSources[1],
			runtime.forkInputs[0].Source,
		)
	}
	if store.prepare.TargetCwd != "/prepared" ||
		!reflect.DeepEqual(
			store.prepare.TargetRuntimeContext,
			map[string]any{"origin": "prepared"},
		) ||
		store.prepare.TargetSettings["model"] != "prepared-model" {
		t.Fatalf("frozen canonical target=%#v", store.prepare)
	}
}

func TestGetSessionForkCapabilitiesUsesLiveRuntimeWithoutPreparation(t *testing.T) {
	store := newFakeSessionForkStore()
	live := ProviderRuntimeSession{
		ID: "source", WorkspaceID: "ws", Provider: "codex",
		ProviderSessionID: "provider-source", Cwd: "/live",
		Env:               []string{"FORK_ENV=live"},
		ProviderTargetRef: map[string]any{"target": "live"},
		RuntimeContext:    map[string]any{"origin": "live"},
		Settings:          &ComposerSettings{Model: "live-model"},
	}
	preparation := &fakeSessionForkPreparation{
		err: errors.New("historical preparation must not run for a live session"),
	}
	runtime := &fakeSessionForkRuntime{}
	host := New(Config{
		SessionForks: store, SessionForkRuntime: runtime,
		Runtime:            liveSessionForkRuntime{session: live},
		RuntimePreparation: preparation,
	})

	capabilities, err := host.GetSessionForkCapabilities(t.Context(), SessionForkCapabilityInput{
		WorkspaceID: "ws", SourceAgentSessionID: "source",
	})
	if err != nil {
		t.Fatalf("GetSessionForkCapabilities() error=%v", err)
	}
	if !capabilities.ThroughTurn || len(preparation.inputs) != 0 {
		t.Fatalf("capabilities=%#v preparation calls=%d", capabilities, len(preparation.inputs))
	}
	if len(runtime.resolvedSources) != 1 ||
		!reflect.DeepEqual(runtime.resolvedSources[0], live) {
		t.Fatalf("resolved live source=%#v, want %#v", runtime.resolvedSources, live)
	}
}

func TestForkSessionDistinguishesMissingSourceFromUnavailableBoundary(t *testing.T) {
	t.Run("missing source", func(t *testing.T) {
		store := newFakeSessionForkStore()
		store.sourceMissing = true
		runtime := &fakeSessionForkRuntime{}
		host := New(Config{SessionForks: store, SessionForkRuntime: runtime})
		_, err := host.ForkSession(context.Background(), ForkSessionInput{
			WorkspaceID: "ws", SourceAgentSessionID: "missing",
			TargetAgentSessionID: "target", RequestID: "request",
			Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
		})
		if !errors.Is(err, ErrSessionNotFound) {
			t.Fatalf("ForkSession() error=%v, want not found", err)
		}
		if runtime.resolveCalls != 0 || runtime.forkCalls != 0 {
			t.Fatalf("runtime calls resolve=%d fork=%d", runtime.resolveCalls, runtime.forkCalls)
		}
	})
	t.Run("unavailable boundary", func(t *testing.T) {
		store := newFakeSessionForkStore()
		store.boundaryUnsupported = true
		store.boundaryReason =
			storesqlite.SessionForkBoundaryReasonTurnSequenceUnverified
		runtime := &fakeSessionForkRuntime{}
		host := New(Config{SessionForks: store, SessionForkRuntime: runtime})
		_, err := host.ForkSession(context.Background(), ForkSessionInput{
			WorkspaceID: "ws", SourceAgentSessionID: "source",
			TargetAgentSessionID: "target", RequestID: "request",
			Point: SessionForkPoint{Kind: SessionForkPointThroughTurn, TurnID: "turn"},
		})
		if !errors.Is(err, storesqlite.ErrSessionForkTurnState) {
			t.Fatalf("ForkSession() error=%v, want boundary conflict", err)
		}
		var reasoner interface{ ForkBoundaryReason() string }
		if !errors.As(err, &reasoner) ||
			reasoner.ForkBoundaryReason() !=
				string(storesqlite.SessionForkBoundaryReasonTurnSequenceUnverified) {
			t.Fatalf("ForkSession() boundary reason=%v", err)
		}
		if runtime.resolveCalls != 0 || runtime.forkCalls != 0 {
			t.Fatalf("runtime calls resolve=%d fork=%d", runtime.resolveCalls, runtime.forkCalls)
		}
	})
}

type fakeSessionForkRuntime struct {
	forkCalls           int
	resolveCalls        int
	providerSessionID   string
	forkErr             error
	forkDisposition     SessionForkDeliveryDisposition
	preserveDisposition bool
	resolveErr          error
	onFork              func()
	descriptors         []SessionForkDriverDescriptor
	resolvedSources     []ProviderRuntimeSession
	forkInputs          []RuntimeSessionForkInput
	mutateFirstResolve  bool
	stateBindingMode    SessionForkStateBindingMode
}

type recoverableSessionForkRuntime struct {
	fakeSessionForkRuntime
	recoveryInput    RuntimeProviderTurnBindingRecoveryInput
	forkability      []bool
	forkabilityCalls int
}

func (r *recoverableSessionForkRuntime) CanForkProviderTurn(
	ctx context.Context,
	input RuntimeProviderTurnForkabilityInput,
) (bool, error) {
	if len(r.forkability) == 0 {
		return r.fakeSessionForkRuntime.CanForkProviderTurn(ctx, input)
	}
	index := r.forkabilityCalls
	if index >= len(r.forkability) {
		index = len(r.forkability) - 1
	}
	r.forkabilityCalls++
	return r.forkability[index], nil
}

func (r *recoverableSessionForkRuntime) RecoverProviderTurnBinding(
	_ context.Context,
	input RuntimeProviderTurnBindingRecoveryInput,
) (RuntimeProviderTurnBindingRecoveryResult, error) {
	r.recoveryInput = input
	return RuntimeProviderTurnBindingRecoveryResult{
		ProviderSessionID:       input.Source.ProviderSessionID,
		ProviderTurnID:          "provider-turn",
		ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
	}, nil
}

type fakeSessionForkStateBinder struct {
	inputs      []SessionForkProviderStateBinding
	err         error
	unsupported bool
}

func (f *fakeSessionForkStateBinder) SupportsSessionForkProviderStateBinding(string) bool {
	return f != nil && !f.unsupported
}

func (f *fakeSessionForkStateBinder) BindSessionForkProviderState(
	_ context.Context,
	input SessionForkProviderStateBinding,
) error {
	f.inputs = append(f.inputs, input)
	return f.err
}

func (f *fakeSessionForkRuntime) ResolveSessionFork(
	_ context.Context,
	source ProviderRuntimeSession,
) (SessionForkDriverDescriptor, error) {
	f.resolveCalls++
	f.resolvedSources = append(
		f.resolvedSources,
		cloneSessionForkRuntimeSource(source),
	)
	if f.mutateFirstResolve && f.resolveCalls == 1 {
		source.Cwd = "/mutated-by-adapter"
		if len(source.Env) > 0 {
			source.Env[0] = "FORK_ENV=mutated"
		}
		source.ProviderTargetRef["target"] = "mutated"
		source.RuntimeContext["origin"] = "mutated"
		if source.Settings != nil {
			source.Settings.Model = "mutated-model"
		}
	}
	if len(f.descriptors) > 0 {
		index := f.resolveCalls - 1
		if index >= len(f.descriptors) {
			index = len(f.descriptors) - 1
		}
		descriptor := f.descriptors[index]
		if descriptor.StateBindingMode == "" {
			descriptor.StateBindingMode = f.effectiveStateBindingMode()
		}
		return descriptor, f.resolveErr
	}
	return SessionForkDriverDescriptor{
		Kind: "codex", Version: "1", ThroughTurn: true,
		StateBindingMode: f.effectiveStateBindingMode(),
	}, f.resolveErr
}

func (*fakeSessionForkRuntime) CanForkProviderTurn(
	_ context.Context,
	input RuntimeProviderTurnForkabilityInput,
) (bool, error) {
	return strings.TrimSpace(input.ProviderTurnID) != "" &&
		len(input.ProviderTurnBindingJSON) > 0, nil
}

func (f *fakeSessionForkRuntime) effectiveStateBindingMode() SessionForkStateBindingMode {
	if f.stateBindingMode != "" {
		return f.stateBindingMode
	}
	return SessionForkStateBindingProviderOwned
}

func (f *fakeSessionForkRuntime) ForkSession(
	_ context.Context,
	input RuntimeSessionForkInput,
) (RuntimeSessionForkResult, error) {
	f.forkCalls++
	f.forkInputs = append(f.forkInputs, input)
	if f.onFork != nil {
		f.onFork()
	}
	disposition := f.forkDisposition
	if !f.preserveDisposition && disposition == "" &&
		f.forkErr == nil && strings.TrimSpace(f.providerSessionID) != "" {
		disposition = SessionForkDeliveryAccepted
	}
	mode := f.effectiveStateBindingMode()
	var targetProviderTurnBindings []SessionForkProviderTurnBinding
	receipt := ""
	if mode == SessionForkStateBindingProviderOwned {
		receipt = "fake-provider-owned-receipt"
		targetProviderTurnBindings = []SessionForkProviderTurnBinding{{
			ProviderTurnID: "forked-" + input.SourceProviderTurnID,
			ProviderTurnBindingJSON: json.RawMessage(
				`{"schemaVersion":1}`,
			),
		}}
	}
	return RuntimeSessionForkResult{
		ProviderSessionID:          f.providerSessionID,
		TargetProviderTurnBindings: targetProviderTurnBindings,
		StateBindingMode:           mode,
		StateBindingReceipt:        receipt,
		DeliveryDisposition:        disposition,
	}, f.forkErr
}

type fakeSessionForkPreparation struct {
	inputs   []RuntimePreparationInput
	prepared PreparedRuntime
	err      error
}

func (f *fakeSessionForkPreparation) Prepare(
	_ context.Context,
	input RuntimePreparationInput,
) (PreparedRuntime, error) {
	f.inputs = append(f.inputs, input)
	return f.prepared, f.err
}

func (*fakeSessionForkPreparation) Cleanup(context.Context, RuntimeCleanupInput) error {
	return nil
}

type liveSessionForkRuntime struct {
	RuntimeController
	session ProviderRuntimeSession
}

func (r liveSessionForkRuntime) Session(
	workspaceID, sessionID string,
) (ProviderRuntimeSession, bool) {
	return r.session, workspaceID == r.session.WorkspaceID && sessionID == r.session.ID
}

func assertPreparedForkSource(t *testing.T, source ProviderRuntimeSession) {
	t.Helper()
	if source.Cwd != "/prepared" ||
		!reflect.DeepEqual(source.ProviderTargetRef, map[string]any{"target": "prepared"}) ||
		!reflect.DeepEqual(source.RuntimeContext, map[string]any{"origin": "prepared"}) ||
		source.Settings == nil ||
		source.Settings.Model != "prepared-model" {
		t.Fatalf("prepared source=%#v", source)
	}
	if value, found := testEnvironmentValue(source.Env, "FORK_ENV"); !found || value != "prepared" {
		t.Fatalf("prepared source env=%#v, want preserved FORK_ENV", source.Env)
	}
	if cwd, found := testEnvironmentValue(source.Env, AgentCWDEnvironmentVariable); !found || cwd != "/prepared" {
		t.Fatalf("prepared source cwd env=%q found=%v, env=%#v", cwd, found, source.Env)
	}
	encoded, found := testEnvironmentValue(source.Env, AgentRailPlacementEnvironmentVariable)
	if !found {
		t.Fatalf("prepared source env=%#v, want rail placement", source.Env)
	}
	placement, err := ParseAgentRailPlacementEnvironment(encoded)
	if err != nil || placement.Kind != RailPlacementKindConversations ||
		placement.SectionKey != storesqlite.RailSectionKeyConversations {
		t.Fatalf("prepared source rail placement=%#v error=%v", placement, err)
	}
}

type fakeSessionForkStore struct {
	operation             storesqlite.SessionForkOperation
	prepare               storesqlite.SessionForkPrepare
	failCommit            bool
	sourceMissing         bool
	boundaryUnsupported   bool
	boundaryReason        storesqlite.SessionForkBoundaryReason
	source                storesqlite.Session
	turnIdentities        []storesqlite.SessionForkTurnIdentity
	listTurnIdentityCalls int
}

type recoverableSessionForkStore struct {
	*fakeSessionForkStore
	claim      storesqlite.SubmitClaim
	recovery   storesqlite.ProviderTurnBindingRecovery
	recovered  bool
	checkCalls int
}

func (s *recoverableSessionForkStore) CheckSessionForkThroughTurn(
	ctx context.Context,
	workspaceID, sessionID, turnID string,
) (storesqlite.SessionForkBoundary, bool, error) {
	s.checkCalls++
	if !s.recovered {
		return storesqlite.SessionForkBoundary{
			RejectionReason: storesqlite.SessionForkBoundaryReasonProviderTurnMissing,
		}, false, nil
	}
	return s.fakeSessionForkStore.CheckSessionForkThroughTurn(
		ctx,
		workspaceID,
		sessionID,
		turnID,
	)
}

func (s *recoverableSessionForkStore) FindSubmitClaimByCanonicalTurn(
	context.Context,
	string,
	string,
	string,
) (storesqlite.SubmitClaim, bool, error) {
	return s.claim, true, nil
}

func (s *recoverableSessionForkStore) RecoverProviderTurnBinding(
	_ context.Context,
	input storesqlite.ProviderTurnBindingRecovery,
) (storesqlite.ProviderTurnBindingRecoveryResult, error) {
	s.recovery = input
	s.recovered = true
	s.boundaryUnsupported = false
	return storesqlite.ProviderTurnBindingRecoveryResult{Changed: true}, nil
}

type turnReadCanonicalStore struct {
	CanonicalStore
	turn storesqlite.Turn
}

func (s turnReadCanonicalStore) GetTurn(
	context.Context,
	string,
	string,
	string,
) (storesqlite.Turn, bool, error) {
	return s.turn, true, nil
}

type pagedSessionForkRecoveryStore struct {
	SessionForkStore
	operations []storesqlite.SessionForkOperation
	failed     map[string]bool
}

func (s *pagedSessionForkRecoveryStore) ListRecoverableSessionForkOperationsPage(
	_ context.Context,
	after storesqlite.SessionForkRecoveryCursor,
	limit int,
) ([]storesqlite.SessionForkOperation, error) {
	operations := append([]storesqlite.SessionForkOperation(nil), s.operations...)
	sort.Slice(operations, func(i, j int) bool {
		if operations[i].CreatedAtUnixMS != operations[j].CreatedAtUnixMS {
			return operations[i].CreatedAtUnixMS < operations[j].CreatedAtUnixMS
		}
		return operations[i].OperationID < operations[j].OperationID
	})
	result := make([]storesqlite.SessionForkOperation, 0, limit)
	for _, operation := range operations {
		if operation.CreatedAtUnixMS < after.CreatedAtUnixMS ||
			(operation.CreatedAtUnixMS == after.CreatedAtUnixMS &&
				operation.OperationID <= after.OperationID) {
			continue
		}
		result = append(result, operation)
		if len(result) == limit {
			break
		}
	}
	return result, nil
}

func (s *pagedSessionForkRecoveryStore) FailPreparedSessionFork(
	_ context.Context,
	_, operationID, _ string,
	_ int64,
) (storesqlite.SessionForkOperation, bool, error) {
	s.failed[operationID] = true
	return storesqlite.SessionForkOperation{
		OperationID: operationID, Status: storesqlite.SessionForkStatusFailed,
	}, true, nil
}

func newFakeSessionForkStore() *fakeSessionForkStore {
	return &fakeSessionForkStore{}
}

func (f *fakeSessionForkStore) session() storesqlite.Session {
	if f.source.ID != "" {
		return f.source
	}
	return storesqlite.Session{
		ID: "source", WorkspaceID: "ws", Kind: storesqlite.SessionKindRoot,
		Provider: "codex", ProviderSessionID: "provider-source",
	}
}

func (f *fakeSessionForkStore) GetSessionForkSource(
	context.Context, string, string,
) (storesqlite.Session, bool, error) {
	if f.sourceMissing {
		return storesqlite.Session{}, false, nil
	}
	return f.session(), true, nil
}

func (f *fakeSessionForkStore) CheckSessionForkThroughTurn(
	context.Context, string, string, string,
) (storesqlite.SessionForkBoundary, bool, error) {
	if f.boundaryUnsupported {
		return storesqlite.SessionForkBoundary{
			RejectionReason: f.boundaryReason,
		}, false, nil
	}
	return storesqlite.SessionForkBoundary{
		Session: f.session(),
		Turn: storesqlite.Turn{
			TurnID: "turn", Phase: storesqlite.TurnPhaseSettled,
			RootProviderTurnID:      "provider-turn",
			ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
		},
		RootProviderTurnIDs: []string{"provider-turn"},
	}, true, nil
}

func (f *fakeSessionForkStore) ListSessionForkTurnIdentities(
	context.Context, string, string,
) ([]storesqlite.SessionForkTurnIdentity, error) {
	f.listTurnIdentityCalls++
	return append(
		[]storesqlite.SessionForkTurnIdentity(nil),
		f.turnIdentities...,
	), nil
}

func (f *fakeSessionForkStore) PrepareSessionFork(
	_ context.Context,
	input storesqlite.SessionForkPrepare,
) (storesqlite.SessionForkOperation, bool, error) {
	f.prepare = input
	if f.operation.OperationID != "" &&
		(f.operation.Status != storesqlite.SessionForkStatusCommitted ||
			f.operation.ClientObservedAtUnixMS <= 0 ||
			f.operation.RequestID == input.RequestID) {
		return f.operation, false, nil
	}
	f.operation = storesqlite.SessionForkOperation{
		OperationID: input.OperationID, WorkspaceID: input.WorkspaceID,
		RequestID: input.RequestID, RequestHash: input.RequestHash,
		SourceAgentSessionID:    input.SourceAgentSessionID,
		TargetAgentSessionID:    input.TargetAgentSessionID,
		SourceProviderSessionID: "provider-source",
		SourceTurnID:            input.SourceTurnID, SourceProviderTurnID: "provider-turn",
		SourceProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
		DriverKind:                    input.DriverKind, DriverVersion: input.DriverVersion,
		Status: storesqlite.SessionForkStatusPrepared,
	}
	return f.operation, true, nil
}

func (f *fakeSessionForkStore) GetSessionForkOperation(
	_ context.Context, _, _ string,
) (storesqlite.SessionForkOperation, bool, error) {
	return f.operation, f.operation.OperationID != "", nil
}

func (f *fakeSessionForkStore) GetSessionForkOperationByRequest(
	_ context.Context, _, requestID string,
) (storesqlite.SessionForkOperation, bool, error) {
	return f.operation, f.operation.RequestID == requestID, nil
}

func (f *fakeSessionForkStore) GetUnknownSessionForkOperation(
	_ context.Context,
	workspaceID, sourceSessionID, pointKind, sourceTurnID string,
) (storesqlite.SessionForkOperation, bool, error) {
	found := f.operation.Status == storesqlite.SessionForkStatusUnknown &&
		f.operation.WorkspaceID == workspaceID &&
		f.operation.SourceAgentSessionID == sourceSessionID &&
		pointKind == storesqlite.SessionForkPointThroughTurn &&
		f.operation.SourceTurnID == sourceTurnID
	return f.operation, found, nil
}

func (f *fakeSessionForkStore) GetBlockingSessionForkOperation(
	_ context.Context,
	workspaceID, sourceSessionID, pointKind, sourceTurnID string,
) (storesqlite.SessionForkOperation, bool, error) {
	blockingStatus := f.operation.Status == storesqlite.SessionForkStatusPrepared ||
		f.operation.Status == storesqlite.SessionForkStatusDispatching ||
		f.operation.Status == storesqlite.SessionForkStatusProviderAccepted ||
		f.operation.Status == storesqlite.SessionForkStatusUnknown ||
		(f.operation.Status == storesqlite.SessionForkStatusCommitted &&
			f.operation.ClientObservedAtUnixMS == 0)
	found := blockingStatus &&
		f.operation.WorkspaceID == workspaceID &&
		f.operation.SourceAgentSessionID == sourceSessionID &&
		pointKind == storesqlite.SessionForkPointThroughTurn &&
		f.operation.SourceTurnID == sourceTurnID
	return f.operation, found, nil
}

func (f *fakeSessionForkStore) ListRecoverableSessionForkOperations(
	context.Context, int,
) ([]storesqlite.SessionForkOperation, error) {
	if f.operation.OperationID == "" {
		return nil, nil
	}
	return []storesqlite.SessionForkOperation{f.operation}, nil
}

func (f *fakeSessionForkStore) ListRecoverableSessionForkOperationsPage(
	context.Context, storesqlite.SessionForkRecoveryCursor, int,
) ([]storesqlite.SessionForkOperation, error) {
	if f.operation.OperationID == "" {
		return nil, nil
	}
	return []storesqlite.SessionForkOperation{f.operation}, nil
}

func (f *fakeSessionForkStore) MarkSessionForkDispatching(
	_ context.Context, _, _ string, _ int64,
) (storesqlite.SessionForkOperation, bool, error) {
	f.operation.Status = storesqlite.SessionForkStatusDispatching
	return f.operation, true, nil
}

func (f *fakeSessionForkStore) RetryUnknownSessionFork(
	_ context.Context, _, _ string, _ int64,
) (storesqlite.SessionForkOperation, bool, error) {
	if f.operation.Status != storesqlite.SessionForkStatusUnknown {
		return f.operation, false, storesqlite.ErrSessionForkTransition
	}
	f.operation.Status = storesqlite.SessionForkStatusDispatching
	f.operation.LastError = ""
	return f.operation, true, nil
}

func (f *fakeSessionForkStore) FailPreparedSessionFork(
	_ context.Context, _, _ string, lastError string, _ int64,
) (storesqlite.SessionForkOperation, bool, error) {
	f.operation.Status = storesqlite.SessionForkStatusFailed
	f.operation.LastError = lastError
	return f.operation, true, nil
}

func (f *fakeSessionForkStore) AcknowledgeSessionForkOperation(
	_ context.Context,
	workspaceID, operationID string,
	now int64,
) (storesqlite.SessionForkOperation, bool, bool, error) {
	found := f.operation.WorkspaceID == workspaceID &&
		f.operation.OperationID == operationID
	if !found {
		return storesqlite.SessionForkOperation{}, false, false, nil
	}
	if f.operation.Status != storesqlite.SessionForkStatusCommitted {
		return f.operation, true, false, storesqlite.ErrSessionForkTransition
	}
	changed := f.operation.ClientObservedAtUnixMS == 0
	if changed {
		f.operation.ClientObservedAtUnixMS = now
	}
	return f.operation, true, changed, nil
}

func (f *fakeSessionForkStore) RecordSessionForkProviderResult(
	_ context.Context,
	input storesqlite.SessionForkProviderResult,
) (storesqlite.SessionForkOperation, bool, error) {
	f.operation.Status = input.Status
	f.operation.TargetProviderSessionID = input.TargetProviderSessionID
	f.operation.TargetProviderTurnBindings = append(
		[]storesqlite.SessionForkProviderTurnBinding(nil),
		input.TargetProviderTurnBindings...,
	)
	f.operation.StateBindingMode = input.StateBindingMode
	f.operation.StateBindingReceipt = input.StateBindingReceipt
	f.operation.LastError = input.LastError
	return f.operation, true, nil
}

func (f *fakeSessionForkStore) CommitSessionFork(
	_ context.Context, _, _ string, _ int64,
) (storesqlite.SessionForkCommitResult, error) {
	if f.failCommit {
		return storesqlite.SessionForkCommitResult{}, errors.New("local commit failed")
	}
	f.operation.Status = storesqlite.SessionForkStatusCommitted
	lineage := storesqlite.SessionForkLineage{
		WorkspaceID:          f.operation.WorkspaceID,
		TargetAgentSessionID: f.operation.TargetAgentSessionID,
		SourceAgentSessionID: f.operation.SourceAgentSessionID,
		SourceTurnID:         f.operation.SourceTurnID,
		OperationID:          f.operation.OperationID,
	}
	return storesqlite.SessionForkCommitResult{
		Operation: f.operation,
		Session: storesqlite.Session{
			ID: f.operation.TargetAgentSessionID, WorkspaceID: f.operation.WorkspaceID,
			ProviderSessionID: f.operation.TargetProviderSessionID,
		},
		Lineage: lineage, Changed: true,
	}, nil
}

func (*fakeSessionForkStore) GetSessionForkLineage(
	context.Context, string, string,
) (storesqlite.SessionForkLineage, bool, error) {
	return storesqlite.SessionForkLineage{}, false, nil
}
