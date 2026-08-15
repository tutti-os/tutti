package host

import (
	"context"
	"errors"
)

// ImplementationAuthorizationRouter selects the authorization owner from the
// exact release frozen into an operation. Managed stdio implementations keep
// authorization with their local implementation host; remote HTTP
// implementations use the account control plane supplied by the product host.
type ImplementationAuthorizationRouter struct {
	managed AuthorizationProvider
	remote  AuthorizationProvider
}

func NewImplementationAuthorizationRouter(
	managed AuthorizationProvider,
	remote AuthorizationProvider,
) *ImplementationAuthorizationRouter {
	return &ImplementationAuthorizationRouter{managed: managed, remote: remote}
}

func (router *ImplementationAuthorizationRouter) provider(release Release) (AuthorizationProvider, error) {
	if router == nil {
		return nil, errors.New("connector authorization router is unavailable")
	}
	var provider AuthorizationProvider
	switch release.Manifest.Implementation.Kind {
	case ImplementationKindManagedStdio:
		provider = router.managed
	case ImplementationKindRemoteStreamableHTTP:
		provider = router.remote
	default:
		return nil, errors.New("connector authorization implementation is unsupported")
	}
	if provider == nil {
		return nil, errors.New("connector authorization provider is unavailable")
	}
	return provider, nil
}

func (router *ImplementationAuthorizationRouter) Begin(
	ctx context.Context,
	request AuthorizationStartRequest,
) (AuthorizationSession, error) {
	provider, err := router.provider(request.Release)
	if err != nil {
		return AuthorizationSession{}, err
	}
	return provider.Begin(ctx, request)
}

func (router *ImplementationAuthorizationRouter) Disconnect(
	ctx context.Context,
	request AuthorizationDisconnectRequest,
) error {
	provider, err := router.provider(request.Release)
	if err != nil {
		return err
	}
	return provider.Disconnect(ctx, request)
}

func (router *ImplementationAuthorizationRouter) Observe(
	ctx context.Context,
	request AuthorizationObserveRequest,
) (AuthorizationObservation, error) {
	provider, err := router.provider(request.Release)
	if err != nil {
		return AuthorizationObservation{}, err
	}
	observer, ok := provider.(AuthorizationObserver)
	if !ok {
		if request.Release.Manifest.Implementation.Kind == ImplementationKindManagedStdio {
			inspector, inspectOK := provider.(AuthorizationInspector)
			if !inspectOK {
				return AuthorizationObservation{}, errors.New("connector authorization inspector is unavailable")
			}
			connector := request.Connector
			connector.Release = request.Release
			observation, inspectErr := inspector.InspectAuthorization(ctx, AuthorizationInspectRequest{
				Scope: request.Scope, Connector: connector,
				AuthorizationSessionID: request.Session.SessionID,
			})
			if inspectErr != nil {
				return AuthorizationObservation{}, inspectErr
			}
			// Inspect reports durable credential state, while Observe reconciles an
			// unresolved authorization attempt. A disconnected credential is still
			// pending until that attempt expires.
			switch observation.State {
			case AuthorizationObservationDisconnected:
				observation.State = AuthorizationObservationPending
			case AuthorizationObservationExpired:
				observation.State = AuthorizationObservationFailed
				if observation.FailureCode == "" {
					observation.FailureCode = "connector_authorization_expired"
				}
			}
			return observation, nil
		}
		return AuthorizationObservation{}, errors.New("connector authorization observer is unavailable")
	}
	return observer.Observe(ctx, request)
}

func (router *ImplementationAuthorizationRouter) InspectAuthorization(
	ctx context.Context,
	request AuthorizationInspectRequest,
) (AuthorizationObservation, error) {
	provider, err := router.provider(request.Connector.Release)
	if err != nil {
		return AuthorizationObservation{}, err
	}
	inspector, ok := provider.(AuthorizationInspector)
	if !ok {
		return AuthorizationObservation{}, errors.New("connector authorization inspector is unavailable")
	}
	return inspector.InspectAuthorization(ctx, request)
}

var _ AuthorizationProvider = (*ImplementationAuthorizationRouter)(nil)
var _ AuthorizationObserver = (*ImplementationAuthorizationRouter)(nil)
var _ AuthorizationInspector = (*ImplementationAuthorizationRouter)(nil)
