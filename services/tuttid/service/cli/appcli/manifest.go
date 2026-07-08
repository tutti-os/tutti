package appcli

import appclicore "github.com/tutti-os/tutti/packages/appcli/core"

const (
	ManifestSchemaVersion = appclicore.ManifestSchemaVersion
	OutputModeJSON        = appclicore.OutputModeJSON
	OutputModeTable       = appclicore.OutputModeTable
	defaultTimeoutMs      = appclicore.DefaultTimeoutMs
	minTimeoutMs          = appclicore.MinTimeoutMs
	maxTimeoutMs          = appclicore.MaxTimeoutMs
)

type Manifest = appclicore.Manifest
type ManifestDocumentation = appclicore.ManifestDocumentation
type ManifestCommand = appclicore.ManifestCommand
type ManifestCommandOutput = appclicore.ManifestCommandOutput
type ManifestTableOutput = appclicore.ManifestTableOutput
type ManifestCommandHandler = appclicore.ManifestCommandHandler

func ReadManifest(path string) (Manifest, error) {
	return appclicore.ReadManifest(path)
}

func CLIManifestPath(packageDir string, manifestPath string) (string, error) {
	return appclicore.PackageRelativePath(packageDir, manifestPath)
}
