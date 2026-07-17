package agentextension

import agentextensionbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentextension"

type InstallationStore interface {
	AgentDir(agentKey string) (string, error)
	PackageDir(agentKey, version string) (string, error)
	ReadActive(agentKey string) (agentextensionbiz.Installation, error)
	ReadInstallation(installationID string) (agentextensionbiz.Installation, error)
	PutActive(agentextensionbiz.Installation) error
}
