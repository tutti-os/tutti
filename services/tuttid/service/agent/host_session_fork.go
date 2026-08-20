package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type serviceHostSessionForkContextPolicy struct{}

func (serviceHostSessionForkContextPolicy) PrepareSessionForkTargetContext(
	_ context.Context,
	_ storesqlite.Session,
	prepared agenthost.ProviderRuntimeSession,
) (agenthost.SessionForkTargetContext, error) {
	return agenthost.SessionForkTargetContext{
		Cwd:            strings.TrimSpace(prepared.Cwd),
		RuntimeContext: clonePayload(prepared.RuntimeContext),
	}, nil
}

type serviceHostSessionForkProviderStateBinder struct {
	runtimePreparer runtimeprep.Preparer
}

func (b serviceHostSessionForkProviderStateBinder) SupportsSessionForkProviderStateBinding(
	provider string,
) bool {
	if b.runtimePreparer == nil {
		return false
	}
	binder, ok := b.runtimePreparer.(runtimeprep.SessionForkProviderStateBinder)
	return ok && binder.SupportsSessionForkProviderStateBinding(provider)
}

func (b serviceHostSessionForkProviderStateBinder) BindSessionForkProviderState(
	ctx context.Context,
	input agenthost.SessionForkProviderStateBinding,
) error {
	if b.runtimePreparer == nil {
		return errors.New("session fork provider state binder is unavailable")
	}
	binder, ok := b.runtimePreparer.(runtimeprep.SessionForkProviderStateBinder)
	if !ok || !binder.SupportsSessionForkProviderStateBinding(input.Provider) {
		return fmt.Errorf(
			"runtime preparer cannot bind %s session fork provider state",
			strings.TrimSpace(input.Provider),
		)
	}
	return binder.BindSessionForkProviderState(
		ctx,
		runtimeprep.SessionForkProviderStateBindingInput{
			WorkspaceID:             input.WorkspaceID,
			Provider:                input.Provider,
			SourceAgentSessionID:    input.SourceAgentSessionID,
			TargetAgentSessionID:    input.TargetAgentSessionID,
			SourceProviderSessionID: input.SourceProviderSessionID,
			TargetProviderSessionID: input.TargetProviderSessionID,
		},
	)
}
