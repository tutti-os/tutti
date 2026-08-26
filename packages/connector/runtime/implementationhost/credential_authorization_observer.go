package implementationhost

import (
	"context"
	"errors"
	"strings"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

func (host *Host) ObserveAuthorization(ctx context.Context, request market.AuthorizationObserveRequest) (market.AuthorizationObservation, error) {
	if host == nil || host.authorizationProvider == nil {
		return market.AuthorizationObservation{}, errors.New("connector authorization observer is unavailable")
	}
	return host.authorizationProvider.Observe(ctx, request)
}

func (provider *managedCredentialAuthorizationProvider) Observe(
	ctx context.Context,
	request market.AuthorizationObserveRequest,
) (market.AuthorizationObservation, error) {
	connector := request.Connector
	connector.Release = request.Release
	route, err := provider.host.authorizationRoute(ctx, request.Scope, connector)
	if err != nil {
		return market.AuthorizationObservation{}, err
	}
	if session := provider.activeAuthorizationSession(route, request.Session); session != nil {
		state, _, _, _, sessionErr := session.snapshot()
		observationState := market.AuthorizationObservationPending
		failureCode := ""
		reason := ""
		switch state {
		case market.AuthorizationStateConnected:
			observationState = market.AuthorizationObservationConnected
		case market.AuthorizationStateFailed:
			observationState = market.AuthorizationObservationFailed
			failureCode = "credential_broker_failed"
		}
		if sessionErr != nil {
			observationState = market.AuthorizationObservationFailed
			failureCode = "credential_broker_failed"
			reason = boundedBrokerMessage(sessionErr.Error())
		}
		return market.AuthorizationObservation{
			AccountID: request.Scope.AccountID, ConnectorKey: connector.Key, ConnectionID: route.connectionID,
			ReleaseDigest: request.Release.ReleaseDigest, AuthorizationSessionID: request.Session.SessionID,
			State: observationState, Reason: reason, FailureCode: failureCode, ObservedAt: time.Now().UTC(),
		}, nil
	}

	observation, err := provider.Inspect(ctx, market.AuthorizationInspectRequest{
		Scope: request.Scope, Connector: connector, AuthorizationSessionID: request.Session.SessionID,
	})
	if err != nil {
		return market.AuthorizationObservation{}, err
	}
	switch observation.State {
	case market.AuthorizationObservationDisconnected:
		observation.State = market.AuthorizationObservationPending
	case market.AuthorizationObservationExpired:
		observation.State = market.AuthorizationObservationFailed
		if observation.FailureCode == "" {
			observation.FailureCode = "connector_authorization_expired"
		}
	}
	return observation, nil
}

func (provider *managedCredentialAuthorizationProvider) activeAuthorizationSession(
	route *connectorRoute,
	wanted market.AuthorizationSession,
) *credentialBrokerSession {
	operationID := strings.TrimSpace(wanted.OperationID)
	if route == nil || operationID == "" || strings.TrimSpace(wanted.SessionID) != operationID+"/credential-broker" {
		return nil
	}
	provider.mu.Lock()
	defer provider.mu.Unlock()
	session := provider.sessions[operationID]
	if session == nil || session.route == nil || session.route.id != route.id {
		return nil
	}
	return session
}
