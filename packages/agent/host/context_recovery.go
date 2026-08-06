package agenthost

import "context"

func (h *Host) prepareRuntimeContextRecovery(
	ctx context.Context,
	ref SessionRef,
	session ProviderRuntimeSession,
	guidance bool,
) (ProviderRuntimeSession, error) {
	if guidance {
		return session, nil
	}
	recoveryRuntime, ok := h.runtime.(RuntimeContextRecoveryController)
	if !ok {
		return session, nil
	}
	recovery, err := recoveryRuntime.PrepareContextRecovery(
		ctx,
		RuntimeContextRecoveryInput(ref),
	)
	if err != nil {
		return ProviderRuntimeSession{}, err
	}
	if recovery.Recovered {
		return recovery.Session, nil
	}
	return session, nil
}
