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
			return AuthorizationObservation{State: AuthorizationObservationPending}, nil
		}
		return AuthorizationObservation{}, errors.New("connector authorization observer is unavailable")
	}
	return observer.Observe(ctx, request)
}

var _ AuthorizationProvider = (*ImplementationAuthorizationRouter)(nil)
var _ AuthorizationObserver = (*ImplementationAuthorizationRouter)(nil)
