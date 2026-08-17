package agentruntime

import (
	"context"
	"errors"
	"strings"
	"sync"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type providerDispatchObserver struct {
	once   sync.Once
	result chan providerDispatchObservation
}

type providerDispatchObservation struct {
	dispatch ProviderDispatchResult
	err      error
}

func newProviderDispatchObserver() *providerDispatchObserver {
	return &providerDispatchObserver{
		result: make(chan providerDispatchObservation, 1),
	}
}

func (observer *providerDispatchObserver) Report(result ProviderDispatchResult) {
	observer.ReportWithError(result, nil)
}

func (observer *providerDispatchObserver) ReportWithError(result ProviderDispatchResult, err error) {
	if observer == nil {
		return
	}
	observer.once.Do(func() {
		observer.result <- providerDispatchObservation{
			dispatch: result,
			err:      err,
		}
		close(observer.result)
	})
}

func (c *Controller) confirmProviderDispatchDurable(
	ctx context.Context,
	session Session,
	turnID string,
	dispatch ProviderDispatchResult,
) (ProviderDispatchResult, error) {
	if dispatch.Disposition != DispatchDispositionApplied || dispatch.Acceptance == nil {
		return dispatch, nil
	}
	receipt := *dispatch.Acceptance
	if receipt.Source != AcceptanceSourceTurnStartResponse ||
		strings.TrimSpace(receipt.ProviderSessionID) == "" ||
		strings.TrimSpace(receipt.ProviderTurnID) == "" ||
		strings.TrimSpace(receipt.ProviderSessionID) !=
			strings.TrimSpace(session.ProviderSessionID) {
		return ProviderDispatchResult{
			Disposition:           DispatchDispositionOutcomeUnknown,
			Acceptance:            &receipt,
			AcceptanceDiagnostics: dispatch.AcceptanceDiagnostics,
		}, errors.New("provider dispatch returned an invalid acceptance receipt")
	}
	eventContext, ok := activityEventContext(
		session,
		"root-provider-turn-started:"+strings.TrimSpace(receipt.ProviderTurnID),
		turnID,
	)
	if !ok {
		return ProviderDispatchResult{
			Disposition: DispatchDispositionOutcomeUnknown,
			Acceptance:  &receipt,
		}, ErrSessionDisconnected
	}
	accepted := activityshared.NewRootProviderTurnStarted(
		eventContext,
		turnID,
		receipt.ProviderTurnID,
	)
	accepted.Payload.ProviderTurnBindingJSON = c.providerTurnBindingJSON(
		ctx,
		session,
		ProviderTurnBindingWriteInput{
			Kind:           ProviderTurnBindingWriteStarted,
			ProviderTurnID: receipt.ProviderTurnID,
		},
	)
	accepted.Payload.Metadata = map[string]any{
		"acceptanceSource": string(receipt.Source),
	}
	// Preserve the stamped ProviderInputUnit from the live provider event so the
	// acceptance commit carries Replay batches. Without it, Claude Code's later
	// re-emit is often an empty-mutation no-op (no TransactionID) and
	// checkpoint_commit_unconfirmed fails for turn.working.
	accepted.ProviderInputUnit = receipt.ProviderInputUnit
	reported, err := c.reportProviderAcceptanceDurable(ctx, session, []activityshared.Event{accepted})
	if err != nil {
		return ProviderDispatchResult{
			Disposition:           DispatchDispositionOutcomeUnknown,
			Acceptance:            &receipt,
			AcceptanceDiagnostics: providerAcceptanceDurabilityFailureDiagnostics(dispatch.AcceptanceDiagnostics),
		}, err
	}
	if !reported {
		return ProviderDispatchResult{
			Disposition:           DispatchDispositionOutcomeUnknown,
			Acceptance:            &receipt,
			AcceptanceDiagnostics: providerAcceptanceDurabilityFailureDiagnostics(dispatch.AcceptanceDiagnostics),
		}, errors.New("durable provider acceptance reporter is unavailable")
	}
	return dispatch, nil
}

func providerAcceptanceDurabilityFailureDiagnostics(
	diagnostics *ProviderAcceptanceDiagnostics,
) *ProviderAcceptanceDiagnostics {
	if diagnostics == nil {
		return &ProviderAcceptanceDiagnostics{
			Status:        "durable_acceptance_failed",
			FailureReason: "durable_provider_acceptance_failed",
		}
	}
	copy := *diagnostics
	copy.Status = "durable_acceptance_failed"
	copy.FailureReason = "durable_provider_acceptance_failed"
	return &copy
}
