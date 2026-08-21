package runtime

import (
	"context"
	"errors"
	"strings"

	connectorhost "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

const (
	ConnectorNodeProfile   = "connector-node-static"
	ConnectorPythonProfile = "connector-python-static"
)

// ConnectorRuntimeResolver resolves and re-verifies a managed runtime on the
// same machine where connector processes execute. Tutti supplies a local
// adapter; VM-backed hosts supply the adapter inside their guest runtime.
type ConnectorRuntimeResolver interface {
	ResolveProfile(context.Context, string) (ResolvedConnectorRuntime, error)
	VerifyLaunch(profile, runtimeName string) (ConnectorExecutable, error)
}

type ResolvedConnectorRuntime struct {
	Root       string
	Profile    string
	ABI        string
	Node       *ConnectorExecutable
	Python     *ConnectorExecutable
	Components map[string]string
}

type ConnectorExecutable struct {
	Path      string
	SHA256    string
	SizeBytes int64
}

// VerifyRuntimeABI binds a connector's published runtime requirement to the
// locally resolved runtime before any connector-controlled entrypoint starts.
func VerifyRuntimeABI(requirement connectorhost.RuntimeRequirement, resolved ResolvedConnectorRuntime) error {
	if requirement.Profile != resolved.Profile || requirement.ABI != resolved.ABI {
		return errors.New("connector runtime ABI does not match the verified local runtime")
	}
	if requirement.Language == "node" && strings.TrimSpace(requirement.VersionRange) != "" &&
		!nodeVersionSatisfies(resolved.Components["node"], requirement.VersionRange) {
		return errors.New("connector Node version requirement does not match the verified local runtime")
	}
	return nil
}
