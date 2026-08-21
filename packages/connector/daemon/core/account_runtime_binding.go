package host

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

var runtimeConnectionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,190}$`)

// AccountRuntimeBindingResolver derives runtime intent from device-scoped
// installation plus account-scoped authorization. It never caches grants.
type AccountRuntimeBindingResolver struct {
	Projections AuthorizationProjectionStore
	Credentials CredentialBrokerGrantIssuer
	Readiness   *AuthorizationReadinessGate
}

func (resolver AccountRuntimeBindingResolver) ResolveRuntimeBinding(
	ctx context.Context,
	request RuntimeBindingRequest,
) (RuntimeBinding, error) {
	connectorKey := strings.TrimSpace(request.Connector.Key)
	if connectorKey == "" {
		connectorKey = strings.TrimSpace(request.Release.ConnectorKey)
	}
	if connectorKey == "" {
		return RuntimeBinding{}, invalidRequest("connectorKey is required for runtime binding")
	}
	remote := request.Release.Manifest.Implementation.RemoteStreamableHTTP != nil
	if request.Release.Manifest.AuthorizationKind == "none" {
		if remote {
			accountID := strings.TrimSpace(request.Scope.AccountID)
			if accountID == "" {
				return RuntimeBinding{ConnectionID: AccountRuntimeConnectionID("signed-out", connectorKey), Enabled: false, AuthorizationState: AuthorizationStateNotRequired}, nil
			}
			return RuntimeBinding{ConnectionID: AccountRuntimeConnectionID(accountID, connectorKey), Enabled: true, AuthorizationState: AuthorizationStateNotRequired}, nil
		}
		return RuntimeBinding{ConnectionID: DeviceRuntimeConnectionID(connectorKey), Enabled: true, AuthorizationState: AuthorizationStateNotRequired}, nil
	}
	accountID := strings.TrimSpace(request.Scope.AccountID)
	if accountID == "" {
		return RuntimeBinding{ConnectionID: AccountRuntimeConnectionID("signed-out", connectorKey), Enabled: false, AuthorizationState: AuthorizationStateDisconnected}, nil
	}
	connectionID := AccountRuntimeConnectionID(accountID, connectorKey)
	if remote && resolver.Readiness != nil && !resolver.Readiness.Ready(accountID) {
		return RuntimeBinding{ConnectionID: connectionID, Enabled: false, AuthorizationState: AuthorizationStateDisconnected}, nil
	}
	if resolver.Projections == nil {
		return RuntimeBinding{ConnectionID: connectionID, Enabled: false, AuthorizationState: AuthorizationStateDisconnected}, nil
	}
	projection, err := resolver.Projections.AuthorizationProjection(ctx, accountID, connectorKey)
	if errors.Is(err, ErrNotFound) {
		return RuntimeBinding{ConnectionID: connectionID, Enabled: false, AuthorizationState: AuthorizationStateDisconnected}, nil
	}
	if err != nil {
		return RuntimeBinding{}, fmt.Errorf("load connector authorization projection: %w", err)
	}
	if projection.AccountID != accountID || projection.ConnectorKey != connectorKey {
		return RuntimeBinding{}, invalidOperationReceipt("authorization projection identity does not match runtime scope")
	}
	if remote && !projection.ServerSynchronized {
		return projectionRuntimeBinding(connectionID, false, AuthorizationStateDisconnected, projection, nil), nil
	}
	// Remote routes have a stable account+connector identity. The server's
	// connectionId is diagnostic authorization state and can change when a
	// default connection changes; it must not create an orphan local route.
	if projectedConnectionID := strings.TrimSpace(projection.ConnectionID); !remote && projectedConnectionID != "" {
		connectionID = projectedConnectionID
	}
	if !runtimeConnectionIDPattern.MatchString(connectionID) {
		return RuntimeBinding{}, invalidOperationReceipt("authorization projection connection id is invalid")
	}
	if projection.State != AuthorizationStateConnected {
		return projectionRuntimeBinding(connectionID, false, projection.State, projection, nil), nil
	}
	if request.Purpose == RuntimeBindingPurposePlan || request.Purpose == RuntimeBindingPurposeDeactivate {
		// Planning persists only non-secret intent. Reconcile resolves a fresh,
		// one-shot credential grant immediately before the host call.
		return projectionRuntimeBinding(connectionID, true, projection.State, projection, nil), nil
	}
	managed := request.Release.Manifest.Implementation.ManagedStdio
	if remote {
		// Remote MCP routes authenticate to tsh-server with the Tutti account
		// session. Provider credentials never cross the daemon boundary.
		return projectionRuntimeBinding(connectionID, true, projection.State, projection, nil), nil
	}
	if managed != nil && managed.CredentialBroker != nil {
		// Connector-owned credential brokers persist their own account binding
		// inside the managed VM user home. They do not consume a Server-issued
		// credential grant when the active CLI/MCP route is reconciled.
		return projectionRuntimeBinding(connectionID, true, projection.State, projection, nil), nil
	}
	if resolver.Credentials == nil {
		return RuntimeBinding{}, NewDomainError(ErrorCodeUnavailable, "credential broker grant issuer is not registered", true, nil)
	}
	grant, err := resolver.Credentials.IssueCredentialBrokerGrant(ctx, accountID, connectorKey, connectionID)
	if err != nil {
		clear(grant)
		return RuntimeBinding{}, fmt.Errorf("issue connector credential broker grant: %w", err)
	}
	if len(grant) == 0 {
		return RuntimeBinding{}, invalidOperationReceipt("credential broker grant issuer returned an empty grant")
	}
	return projectionRuntimeBinding(connectionID, true, projection.State, projection, grant), nil
}

func projectionRuntimeBinding(
	connectionID string,
	enabled bool,
	state AuthorizationState,
	projection AuthorizationProjection,
	grant []byte,
) RuntimeBinding {
	return RuntimeBinding{
		ConnectionID:          connectionID,
		Enabled:               enabled,
		AuthorizationState:    state,
		ConnectionVersion:     projection.ConnectionVersion,
		ServerRevision:        projection.ServerRevision,
		CredentialBrokerGrant: grant,
	}
}

func DeviceRuntimeConnectionID(connectorKey string) string {
	return "device-" + strings.TrimSpace(connectorKey)
}

func AccountRuntimeConnectionID(accountID, connectorKey string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(accountID) + "\x00" + strings.TrimSpace(connectorKey)))
	return "account-" + hex.EncodeToString(digest[:16])
}
