package agentextension

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func (m *Manager) installVerifiedRelease(
	release Release,
	artifact []byte,
	source tuttitypes.AgentExtensionSource,
	preferManagedRuntime bool,
) (Installation, error) {
	installation, err := m.prepareVerifiedRelease(release, artifact, source, preferManagedRuntime)
	if err != nil {
		return Installation{}, err
	}
	if err := m.Installations.PutActive(installation); err != nil {
		return Installation{}, err
	}
	return installation, nil
}

func (m *Manager) prepareVerifiedRelease(
	release Release,
	artifact []byte,
	source tuttitypes.AgentExtensionSource,
	preferManagedRuntime bool,
) (Installation, error) {
	if m.Installations == nil {
		return Installation{}, errors.New("agent extension installation store is not configured")
	}
	if err := verifyRelease(release, source); err != nil {
		return Installation{}, err
	}
	artifactDigest := sha256.Sum256(artifact)
	actualArtifactSHA256 := hex.EncodeToString(artifactDigest[:])
	if release.ArtifactSHA256 != "" && strings.ToLower(release.ArtifactSHA256) != actualArtifactSHA256 {
		return Installation{}, errors.New("extension artifact does not match release SHA-256")
	}
	if release.ArtifactSizeBytes != 0 && release.ArtifactSizeBytes != int64(len(artifact)) {
		return Installation{}, errors.New("extension artifact does not match release size")
	}
	release.ArtifactSHA256 = actualArtifactSHA256
	release.ArtifactSizeBytes = int64(len(artifact))
	finalDir, err := m.Installations.PackageDir(release.AgentKey, release.Version)
	if err != nil {
		return Installation{}, err
	}
	root := filepath.Dir(finalDir)
	if err := os.MkdirAll(root, 0o700); err != nil {
		return Installation{}, err
	}
	staging, err := os.MkdirTemp(root, ".install-")
	if err != nil {
		return Installation{}, err
	}
	defer os.RemoveAll(staging)
	if err := extractPackage(artifact, staging); err != nil {
		return Installation{}, err
	}
	manifest, err := validateInstalledPackage(staging, release.AgentKey, release.Version)
	if err != nil {
		return Installation{}, err
	}
	if !reflect.DeepEqual(manifest, release.Manifest) {
		return Installation{}, errors.New("signed release manifest does not match artifact package")
	}
	if err := persistSignedPackageAuthority(staging, release, artifact); err != nil {
		return Installation{}, err
	}
	contentDigest, err := packageContentSHA256(staging)
	if err != nil {
		return Installation{}, err
	}
	signedContentDigest, err := packageArchiveContentSHA256(artifact)
	if err != nil || signedContentDigest != contentDigest {
		return Installation{}, errors.New("extracted extension package does not match signed artifact content")
	}
	if err := activateExtensionPackage(staging, finalDir, contentDigest); err != nil {
		return Installation{}, err
	}
	authorityManifest, authorityDigest, authorityRelease, err := m.verifySignedPackageAuthority(finalDir, release.AgentKey, release.Version)
	if err != nil || authorityDigest != contentDigest || !reflect.DeepEqual(authorityManifest, manifest) ||
		authorityRelease.ArtifactSHA256 != release.ArtifactSHA256 {
		if err != nil {
			return Installation{}, err
		}
		return Installation{}, errors.New("activated extension package does not match signed release authority")
	}
	installation := Installation{
		SchemaVersion: "tutti.agent.installation.v1", ID: release.AgentKey + "@" + release.Version,
		AgentKey: release.AgentKey, Version: release.Version, Provider: "acp:" + release.AgentKey,
		PackageDir: finalDir, PackageContentSHA256: contentDigest,
		ReleaseArtifactSHA256: strings.ToLower(release.ArtifactSHA256), ReleaseArtifactSizeBytes: release.ArtifactSizeBytes,
		Manifest: manifest, InstalledAt: time.Now().UTC(), PreferManagedRuntime: preferManagedRuntime,
	}
	locales := map[string]string{}
	if err := readJSON(filepath.Join(finalDir, filepath.FromSlash(manifest.LocalizationInfo.DefaultFile)), &locales); err != nil {
		return Installation{}, fmt.Errorf("read extension default locale: %w", err)
	}
	installation.DisplayName = strings.TrimSpace(locales["agent.name"])
	if installation.DisplayName == "" {
		installation.DisplayName = manifest.Name
	}
	installation.AuthMessage = strings.TrimSpace(locales["runtime.authRequired"])
	if err := m.Installations.PutInstallation(installation); err != nil {
		return Installation{}, err
	}
	return installation, nil
}
