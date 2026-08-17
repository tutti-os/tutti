package host

import (
	"context"
	"testing"
)

type routedAuthorizationProvider struct {
	beginCount      int
	disconnectCount int
	observeCount    int
}

type inspectOnlyAuthorizationProvider struct {
	inspectCount int
	observation  AuthorizationObservation
}

func (*inspectOnlyAuthorizationProvider) Begin(context.Context, AuthorizationStartRequest) (AuthorizationSession, error) {
	return AuthorizationSession{}, nil
}

func (*inspectOnlyAuthorizationProvider) Disconnect(context.Context, AuthorizationDisconnectRequest) error {
	return nil
}

func (provider *inspectOnlyAuthorizationProvider) InspectAuthorization(
	context.Context,
	AuthorizationInspectRequest,
) (AuthorizationObservation, error) {
	provider.inspectCount++
	if provider.observation.State == "" {
		return AuthorizationObservation{State: AuthorizationObservationConnected}, nil
	}
	return provider.observation, nil
}

func TestImplementationAuthorizationRouterKeepsDisconnectedManagedSessionPending(t *testing.T) {
	managed := &inspectOnlyAuthorizationProvider{observation: AuthorizationObservation{State: AuthorizationObservationDisconnected}}
	router := NewImplementationAuthorizationRouter(managed, &routedAuthorizationProvider{})
	release := Release{Manifest: Manifest{Implementation: Implementation{Kind: ImplementationKindManagedStdio}}}

	observation, err := router.Observe(context.Background(), AuthorizationObserveRequest{
		Connector: Connector{Key: "wecom", Release: release}, Release: release,
		Session: AuthorizationSession{SessionID: "session-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if observation.State != AuthorizationObservationPending {
		t.Fatalf("observation state = %q, want pending", observation.State)
	}
}

func TestImplementationAuthorizationRouterFailsExpiredManagedSession(t *testing.T) {
	managed := &inspectOnlyAuthorizationProvider{observation: AuthorizationObservation{State: AuthorizationObservationExpired}}
	router := NewImplementationAuthorizationRouter(managed, &routedAuthorizationProvider{})
	release := Release{Manifest: Manifest{Implementation: Implementation{Kind: ImplementationKindManagedStdio}}}

	observation, err := router.Observe(context.Background(), AuthorizationObserveRequest{
		Connector: Connector{Key: "wecom", Release: release}, Release: release,
		Session: AuthorizationSession{SessionID: "session-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if observation.State != AuthorizationObservationFailed || observation.FailureCode != "connector_authorization_expired" {
		t.Fatalf("observation = %#v, want terminal expiry", observation)
	}
}

func (provider *routedAuthorizationProvider) Begin(_ context.Context, request AuthorizationStartRequest) (AuthorizationSession, error) {
	provider.beginCount++
	return AuthorizationSession{OperationID: request.OperationID, ConnectorKey: request.Connector.Key}, nil
}

func (provider *routedAuthorizationProvider) Disconnect(context.Context, AuthorizationDisconnectRequest) error {
	provider.disconnectCount++
	return nil
}

func (provider *routedAuthorizationProvider) Observe(context.Context, AuthorizationObserveRequest) (AuthorizationObservation, error) {
	provider.observeCount++
	return AuthorizationObservation{State: AuthorizationObservationConnected}, nil
}

func TestImplementationAuthorizationRouterUsesFrozenReleaseKind(t *testing.T) {
	managed := &routedAuthorizationProvider{}
	remote := &routedAuthorizationProvider{}
	router := NewImplementationAuthorizationRouter(managed, remote)
	remoteRelease := Release{Manifest: Manifest{Implementation: Implementation{Kind: ImplementationKindRemoteStreamableHTTP}}}
	managedRelease := Release{Manifest: Manifest{Implementation: Implementation{Kind: ImplementationKindManagedStdio}}}

	if _, err := router.Begin(context.Background(), AuthorizationStartRequest{
		OperationID: "begin-1", Connector: Connector{Key: "documents", Release: managedRelease}, Release: remoteRelease,
	}); err != nil {
		t.Fatal(err)
	}
	if err := router.Disconnect(context.Background(), AuthorizationDisconnectRequest{
		Connector: Connector{Key: "documents", Release: remoteRelease}, Release: managedRelease,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := router.Observe(context.Background(), AuthorizationObserveRequest{
		Connector: Connector{Key: "documents", Release: managedRelease}, Release: remoteRelease,
	}); err != nil {
		t.Fatal(err)
	}
	if managed.beginCount != 0 || managed.disconnectCount != 1 || managed.observeCount != 0 {
		t.Fatalf("managed calls = begin:%d disconnect:%d observe:%d", managed.beginCount, managed.disconnectCount, managed.observeCount)
	}
	if remote.beginCount != 1 || remote.disconnectCount != 0 || remote.observeCount != 1 {
		t.Fatalf("remote calls = begin:%d disconnect:%d observe:%d", remote.beginCount, remote.disconnectCount, remote.observeCount)
	}
}

func TestImplementationAuthorizationRouterRejectsUnsupportedImplementation(t *testing.T) {
	router := NewImplementationAuthorizationRouter(&routedAuthorizationProvider{}, &routedAuthorizationProvider{})
	if _, err := router.Begin(context.Background(), AuthorizationStartRequest{Release: Release{}}); err == nil {
		t.Fatal("expected unsupported implementation error")
	}
}

func TestImplementationAuthorizationRouterUsesInspectorToRecoverManagedObservation(t *testing.T) {
	managed := &inspectOnlyAuthorizationProvider{}
	router := NewImplementationAuthorizationRouter(managed, &routedAuthorizationProvider{})
	release := Release{Manifest: Manifest{Implementation: Implementation{Kind: ImplementationKindManagedStdio}}}
	observation, err := router.Observe(context.Background(), AuthorizationObserveRequest{
		Connector: Connector{Key: "lark", Release: release}, Release: release,
		Session: AuthorizationSession{SessionID: "session-1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if managed.inspectCount != 1 || observation.State != AuthorizationObservationConnected {
		t.Fatalf("managed inspection = %d, observation = %#v", managed.inspectCount, observation)
	}
}
