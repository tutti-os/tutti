package host

import (
	"context"
	"strings"
)

func (application *Application) executeRuntimeReconcile(ctx context.Context, operation Operation) error {
	connector, err := application.config.Repository.Connector(ctx, operation.ConnectorKey)
	if err != nil {
		return err
	}
	release, err := application.installedReleaseEvidence(ctx, connector)
	if err != nil {
		return err
	}
	connector.Release = release
	binding, err := application.resolveRuntimeBinding(ctx, operation, connector, release, RuntimeBindingPurposeReconcile)
	if err != nil {
		return err
	}
	connector.Authorization.State = binding.AuthorizationState
	receipt, err := application.reconcileRuntime(ctx, RuntimeReconcileRequest{
		OperationID: operation.OperationID, Scope: operation.Scope, ConnectionID: binding.ConnectionID,
		Connector: connector, Enabled: binding.Enabled, Generation: operation.HostGeneration,
		CredentialBrokerGrant: binding.CredentialBrokerGrant,
	})
	if err != nil {
		return NewDomainError(ErrorCodeInstallFailed, "connector runtime could not be reconciled", true, err)
	}
	if err := validateRuntimeReceipt(receipt, operation.OperationID, binding.ConnectionID, connector.Key,
		release.ReleaseDigest, operation.HostGeneration, binding.Enabled); err != nil {
		return err
	}
	return application.completeConnectorOperation(ctx, operation.OperationID, func(current Connector) Connector { return current })
}

func (application *Application) resolveRuntimeBinding(
	ctx context.Context,
	operation Operation,
	connector Connector,
	release Release,
	purpose RuntimeBindingPurpose,
) (RuntimeBinding, error) {
	binding, err := application.config.RuntimeBindings.ResolveRuntimeBinding(ctx, RuntimeBindingRequest{
		OperationID: operation.OperationID, Scope: operation.Scope, Purpose: purpose, Connector: connector, Release: release,
	})
	if err != nil {
		clear(binding.CredentialBrokerGrant)
		return RuntimeBinding{}, err
	}
	binding.ConnectionID = strings.TrimSpace(binding.ConnectionID)
	if binding.ConnectionID == "" || (!binding.Enabled && len(binding.CredentialBrokerGrant) != 0) {
		clear(binding.CredentialBrokerGrant)
		return RuntimeBinding{}, invalidOperationReceipt("runtime binding resolver returned invalid intent")
	}
	return binding, nil
}

func (application *Application) reconcileRuntime(ctx context.Context, request RuntimeReconcileRequest) (RuntimeReceipt, error) {
	defer clear(request.CredentialBrokerGrant)
	return application.config.Host.Reconcile(ctx, request)
}

type defaultRuntimeBindingResolver struct{}

func (defaultRuntimeBindingResolver) ResolveRuntimeBinding(context.Context, RuntimeBindingRequest) (RuntimeBinding, error) {
	return RuntimeBinding{ConnectionID: defaultConnectorConnectionID, Enabled: true, AuthorizationState: AuthorizationStateNotRequired}, nil
}
