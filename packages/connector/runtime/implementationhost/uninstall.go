package implementationhost

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

func (host *Host) deactivateConnector(request market.RuntimeDeactivationRequest) error {
	match := func(route connectorruntime.ManagedRoute) bool {
		candidate, ok := route.(*connectorRoute)
		return ok && candidate.connectorKey == request.ConnectorKey
	}
	routeErr := host.routes.RemoveMatching(match, request.Generation, request.Deadline)

	host.authorizationMu.Lock()
	authorizationRoutes := make([]*connectorRoute, 0)
	for key, route := range host.authorizationRoutes {
		if route.connectorKey != request.ConnectorKey {
			continue
		}
		delete(host.authorizationRoutes, key)
		authorizationRoutes = append(authorizationRoutes, route)
	}
	host.authorizationMu.Unlock()
	var authorizationErrs []error
	for _, route := range authorizationRoutes {
		host.authorizationProvider.cancelAuthorizationSessionByRoute(route.id)
		route.Fence()
		if err := route.Close(request.Deadline); err != nil {
			// Keep a fenced route reachable so an idempotent uninstall retry can
			// finish snapshot/process cleanup after a transient close failure.
			host.authorizationMu.Lock()
			if host.authorizationRoutes[route.id] == nil {
				host.authorizationRoutes[route.id] = route
			}
			host.authorizationMu.Unlock()
			authorizationErrs = append(authorizationErrs, err)
		}
	}
	shimErr := host.removeOrphanedConnectorCLIShim(request.ConnectorKey)
	host.notifyRouteChanged()
	return errors.Join(routeErr, errors.Join(authorizationErrs...), shimErr)
}

func (host *Host) removeOrphanedConnectorCLIShim(connectorKey string) error {
	if !hostIdentityPattern.MatchString(connectorKey) {
		return errors.New("connector CLI shim removal identity is invalid")
	}
	if !filepath.IsAbs(host.binDir) {
		return nil
	}
	command := "tutti-connector-" + connectorKey
	if runtime.GOOS == "windows" {
		command += ".cmd"
	}
	path := filepath.Join(host.binDir, command)
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read connector CLI shim before removal: %w", err)
	}
	managedMarker := "export TUTTI_CONNECTOR_KEY=" + shellQuote(connectorKey) + "\n"
	if runtime.GOOS == "windows" {
		managedMarker = "set \"TUTTI_CONNECTOR_KEY=" + connectorKey + "\"\r\n"
	}
	if !strings.Contains(string(content), managedMarker) {
		return errors.New("connector CLI shim removal target is not Tutti-managed")
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove connector CLI shim: %w", err)
	}
	return nil
}
