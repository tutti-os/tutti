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
	result chan ProviderDispatchResult
}

func newProviderDispatchObserver() *providerDispatchObserver {
	return &providerDispatchObserver{result: make(chan ProviderDispatchResult, 1)}
}

func (observer *providerDispatchObserver) Report(result ProviderDispatchResult) {
	if observer == nil {
		return
	}
	observer.once.Do(func() {
		observer.result <- result
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
		strings.TrimSpace(receipt.ProviderTurnID) == "" {
		return ProviderDispatchResult{
			Disposition: DispatchDispositionOutcomeUnknown,
		}, errors.New("provider dispatch returned an incomplete acceptance receipt")
	}
	eventContext, ok := activityEventContext(
		session,
		"root-provider-turn-started:"+strings.TrimSpace(receipt.ProviderTurnID),
		turnID,
	)
	if !ok {
		return ProviderDispatchResult{
			Disposition: DispatchDispositionOutcomeUnknown,
		}, ErrSessionDisconnected
	}
	accepted := activityshared.NewRootProviderTurnStarted(
		eventContext,
		turnID,
		receipt.ProviderTurnID,
	)
	accepted.Payload.Metadata = map[string]any{
		"acceptanceSource": string(receipt.Source),
	}
	reported, err := c.reportProviderAcceptanceDurable(ctx, session, []activityshared.Event{accepted})
	if err != nil {
		return ProviderDispatchResult{
			Disposition: DispatchDispositionOutcomeUnknown,
		}, err
	}
	if !reported {
		return ProviderDispatchResult{
			Disposition: DispatchDispositionOutcomeUnknown,
		}, errors.New("durable provider acceptance reporter is unavailable")
	}
	return dispatch, nil
}
