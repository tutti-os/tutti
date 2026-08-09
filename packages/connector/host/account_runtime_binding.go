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
	if request.Release.Manifest.AuthorizationKind == "none" {
		return RuntimeBinding{ConnectionID: DeviceRuntimeConnectionID(connectorKey), Enabled: true}, nil
	}
	accountID := strings.TrimSpace(request.Scope.AccountID)
	if accountID == "" {
		return RuntimeBinding{}, invalidRequest("accountId is required for an authorized connector runtime")
	}
	connectionID := AccountRuntimeConnectionID(accountID, connectorKey)
	if resolver.Projections == nil {
		return RuntimeBinding{ConnectionID: connectionID, Enabled: false}, nil
	}
	projection, err := resolver.Projections.AuthorizationProjection(ctx, accountID, connectorKey)
	if errors.Is(err, ErrNotFound) {
		return RuntimeBinding{ConnectionID: connectionID, Enabled: false}, nil
	}
	if err != nil {
		return RuntimeBinding{}, fmt.Errorf("load connector authorization projection: %w", err)
	}
	if projection.AccountID != accountID || projection.ConnectorKey != connectorKey {
		return RuntimeBinding{}, invalidOperationReceipt("authorization projection identity does not match runtime scope")
	}
	if projectedConnectionID := strings.TrimSpace(projection.ConnectionID); projectedConnectionID != "" {
		connectionID = projectedConnectionID
	}
	if !runtimeConnectionIDPattern.MatchString(connectionID) {
		return RuntimeBinding{}, invalidOperationReceipt("authorization projection connection id is invalid")
	}
	if projection.State != AuthorizationStateConnected {
		return RuntimeBinding{ConnectionID: connectionID, Enabled: false}, nil
	}
	if request.Purpose == RuntimeBindingPurposeDeactivate || request.Purpose == RuntimeBindingPurposeInstallationProbe {
		return RuntimeBinding{ConnectionID: connectionID, Enabled: true}, nil
	}
	managed := request.Release.Manifest.Implementation.ManagedStdio
	if managed != nil && managed.CredentialBroker != nil {
		// Connector-owned credential brokers persist their own account binding
		// inside the managed VM user home. They do not consume a Server-issued
		// credential grant when the active CLI/MCP route is reconciled.
		return RuntimeBinding{ConnectionID: connectionID, Enabled: true}, nil
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
	return RuntimeBinding{ConnectionID: connectionID, Enabled: true, CredentialBrokerGrant: grant}, nil
}

func DeviceRuntimeConnectionID(connectorKey string) string {
	return "device-" + strings.TrimSpace(connectorKey)
}

func AccountRuntimeConnectionID(accountID, connectorKey string) string {
	digest := sha256.Sum256([]byte(strings.TrimSpace(accountID) + "\x00" + strings.TrimSpace(connectorKey)))
	return "account-" + hex.EncodeToString(digest[:16])
}
