package managedruntime

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"strconv"
	"strings"
	"sync"

	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

const (
	ConnectorNodeProfile   = connectorruntime.ConnectorNodeProfile
	ConnectorPythonProfile = connectorruntime.ConnectorPythonProfile
)

// ConnectorRuntimeResolverConfig injects the shared v2 managed-runtime
// resolver. Catalog selection remains owned by DefaultResolver, including its
// TUTTI_APP_RUNTIME_CATALOG override, rather than by Connector Market wiring.
type ConnectorRuntimeResolverConfig struct {
	Resolver DefaultResolver
}

type ConnectorRuntimeResolver struct {
	resolver DefaultResolver

	mu          sync.Mutex
	executables map[string]ConnectorExecutable
}

// These aliases preserve the existing Tutti adapter API while the canonical
// runtime contract lives in packages/connector/runtime.
type ResolvedConnectorRuntime = connectorruntime.ResolvedConnectorRuntime
type ConnectorExecutable = connectorruntime.ConnectorExecutable

func NewConnectorRuntimeResolver(config ConnectorRuntimeResolverConfig) (*ConnectorRuntimeResolver, error) {
	return &ConnectorRuntimeResolver{
		resolver:    config.Resolver,
		executables: make(map[string]ConnectorExecutable),
	}, nil
}

func (resolver *ConnectorRuntimeResolver) ResolveProfile(ctx context.Context, profile string) (ResolvedConnectorRuntime, error) {
	if resolver == nil {
		return ResolvedConnectorRuntime{}, errors.New("connector managed runtime resolver is nil")
	}
	profile, err := validatedConnectorProfile(profile)
	if err != nil {
		return ResolvedConnectorRuntime{}, err
	}

	entry, err := resolver.catalogEntry(ctx)
	if err != nil {
		return ResolvedConnectorRuntime{}, err
	}
	componentName := connectorProfileRuntimeName(profile)
	component, ok := entry.Components[componentName]
	if !ok {
		return ResolvedConnectorRuntime{}, fmt.Errorf("managed app runtime catalog does not contain %q component", componentName)
	}

	var shared ResolvedRuntime
	switch profile {
	case ConnectorNodeProfile:
		shared, err = resolver.resolver.ResolveProfile(ctx, ConnectorNodeProfile)
	case ConnectorPythonProfile:
		// The published v2 catalog has no Python-only profile. Reuse its
		// baseline and expose only Python to the connector process.
		shared, err = resolver.resolver.Resolve(ctx)
	}
	if err != nil {
		return ResolvedConnectorRuntime{}, err
	}

	executablePath := shared.Node
	if componentName == "python" {
		executablePath = shared.Python
	}
	executable, err := executableIdentity(executablePath)
	if err != nil {
		return ResolvedConnectorRuntime{}, err
	}
	abi := strings.TrimSpace(entry.ProfileABIs[profile])
	if abi == "" {
		abi, err = connectorRuntimeABI(componentName, component.Version)
		if err != nil {
			return ResolvedConnectorRuntime{}, err
		}
	}

	result := ResolvedConnectorRuntime{
		Root:       shared.Root,
		Profile:    profile,
		ABI:        abi,
		Components: map[string]string{componentName: component.Version},
	}
	if componentName == "node" {
		result.Node = &executable
	} else {
		result.Python = &executable
	}

	resolver.mu.Lock()
	resolver.executables[connectorExecutableKey(profile, componentName)] = executable
	resolver.mu.Unlock()
	return result, nil
}

// VerifyLaunch detects replacement of the resolved executable between runtime
// resolution and process start. Artifact authenticity remains governed by the
// shared v2 catalog's archive SHA-256 verification.
func (resolver *ConnectorRuntimeResolver) VerifyLaunch(profile, runtimeName string) (ConnectorExecutable, error) {
	if resolver == nil {
		return ConnectorExecutable{}, errors.New("connector managed runtime resolver is nil")
	}
	profile, err := validatedConnectorProfile(profile)
	if err != nil {
		return ConnectorExecutable{}, err
	}
	runtimeName = strings.TrimSpace(runtimeName)
	if runtimeName != connectorProfileRuntimeName(profile) {
		return ConnectorExecutable{}, fmt.Errorf("runtime %q is not present in connector profile %q", runtimeName, profile)
	}

	resolver.mu.Lock()
	expected, ok := resolver.executables[connectorExecutableKey(profile, runtimeName)]
	resolver.mu.Unlock()
	if !ok {
		return ConnectorExecutable{}, fmt.Errorf("connector runtime profile %q has not been resolved", profile)
	}
	actual, err := executableIdentity(expected.Path)
	if err != nil {
		return ConnectorExecutable{}, err
	}
	if actual != expected {
		return ConnectorExecutable{}, fmt.Errorf("connector runtime %s launch identity changed after resolution", runtimeName)
	}
	return actual, nil
}

func (resolver *ConnectorRuntimeResolver) catalogEntry(ctx context.Context) (appRuntimeCatalogEntry, error) {
	source := resolver.resolver.runtimeCatalogSource()
	if source == "" {
		return appRuntimeCatalogEntry{}, fmt.Errorf("managed app runtime catalog is unavailable and %s is not configured", tuttiAppRuntimeCatalogEnv)
	}
	catalog, err := resolver.resolver.loadCatalog(ctx, source)
	if err != nil {
		return appRuntimeCatalogEntry{}, err
	}
	platform := appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH)
	entry, ok := catalog.Runtimes[platform]
	if !ok {
		return appRuntimeCatalogEntry{}, fmt.Errorf("managed app runtime catalog does not contain platform %q", platform)
	}
	return entry, nil
}

func validatedConnectorProfile(profile string) (string, error) {
	profile = strings.TrimSpace(profile)
	if profile != ConnectorNodeProfile && profile != ConnectorPythonProfile {
		return "", fmt.Errorf("connector managed runtime profile %q is unsupported", profile)
	}
	return profile, nil
}

func connectorProfileRuntimeName(profile string) string {
	if profile == ConnectorPythonProfile {
		return "python"
	}
	return "node"
}

func connectorRuntimeABI(runtimeName, version string) (string, error) {
	version = strings.TrimSpace(version)
	majorText, _, _ := strings.Cut(version, ".")
	major, err := strconv.Atoi(majorText)
	if err != nil || major <= 0 {
		return "", fmt.Errorf("managed %s runtime version %q cannot produce a connector ABI", runtimeName, version)
	}
	return runtimeName + strconv.Itoa(major) + "-" + appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH), nil
}

func connectorExecutableKey(profile, runtimeName string) string {
	return profile + "\x00" + runtimeName
}

func executableIdentity(path string) (ConnectorExecutable, error) {
	if !isExecutableFile(path) {
		return ConnectorExecutable{}, fmt.Errorf("connector runtime executable is unavailable at %s", path)
	}
	digest, size, err := fileSHA256AndSize(path)
	if err != nil {
		return ConnectorExecutable{}, err
	}
	return ConnectorExecutable{Path: path, SHA256: digest, SizeBytes: size}, nil
}
