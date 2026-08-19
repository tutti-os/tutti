package hostadapter

import (
	"context"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	host "github.com/tutti-os/tutti/packages/agent/host"
)

type providerTurnBindingRecoveryBackend interface {
	RecoverProviderTurnBinding(
		context.Context,
		agentruntime.ProviderTurnBindingRecoveryInput,
	) (agentruntime.ProviderTurnBindingRecoveryResult, error)
}

func (a *RuntimeController) RecoverProviderTurnBinding(
	ctx context.Context,
	input host.RuntimeProviderTurnBindingRecoveryInput,
) (host.RuntimeProviderTurnBindingRecoveryResult, error) {
	if err := a.requireBackend(); err != nil {
		return host.RuntimeProviderTurnBindingRecoveryResult{}, err
	}
	backend, ok := a.Backend.(providerTurnBindingRecoveryBackend)
	if !ok {
		return host.RuntimeProviderTurnBindingRecoveryResult{},
			host.ErrSessionForkUnsupported
	}
	result, err := backend.RecoverProviderTurnBinding(
		ctx,
		agentruntime.ProviderTurnBindingRecoveryInput{
			Source:               runtimeSession(input.Source),
			CanonicalTurnID:      input.CanonicalTurnID,
			RecoveryToken:        input.RecoveryToken,
			LegacyTextHMACKey:    input.LegacyTextHMACKey,
			LegacyTextHMACDigest: input.LegacyTextHMACDigest,
		},
	)
	return host.RuntimeProviderTurnBindingRecoveryResult{
		ProviderSessionID:       result.ProviderSessionID,
		ProviderTurnID:          result.ProviderTurnID,
		ProviderTurnBindingJSON: append([]byte(nil), result.ProviderTurnBindingJSON...),
	}, mapRuntimeError(err)
}
