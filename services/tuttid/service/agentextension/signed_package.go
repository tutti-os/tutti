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

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func persistSignedPackageAuthority(root string, release Release, artifact []byte) error {
	if err := writeJSONAtomic(filepath.Join(root, signedReleaseRecordName), release); err != nil {
		return fmt.Errorf("persist signed extension release: %w", err)
	}
	if err := writeBytesAtomic(filepath.Join(root, signedReleaseArtifactName), artifact, 0o400); err != nil {
		return fmt.Errorf("persist signed extension artifact: %w", err)
	}
	return nil
}

func (m *Manager) verifySignedPackageAuthority(root, key, version string) (Manifest, string, Release, error) {
	var release Release
	if err := readJSON(filepath.Join(root, signedReleaseRecordName), &release); err != nil {
		return Manifest{}, "", Release{}, fmt.Errorf("read signed extension release authority: %w", err)
	}
	source, ok := m.sourceForSignedRelease(key, release.Signature.KeyID)
	if !ok {
		return Manifest{}, "", Release{}, errors.New("configured extension signing authority is unavailable")
	}
	if err := verifyRelease(release, source); err != nil {
		return Manifest{}, "", Release{}, fmt.Errorf("reverify installed extension release: %w", err)
	}
	if release.AgentKey != key || release.Version != version || !validPackageContentSHA256(strings.ToLower(release.ArtifactSHA256)) ||
		release.ArtifactSizeBytes <= 0 || release.ArtifactSizeBytes > maxArtifact {
		return Manifest{}, "", Release{}, errors.New("installed signed release authority identity is invalid")
	}
	artifactPath := filepath.Join(root, signedReleaseArtifactName)
	info, err := os.Lstat(artifactPath)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() != release.ArtifactSizeBytes {
		return Manifest{}, "", Release{}, errors.New("installed signed release artifact is missing or unsafe")
	}
	artifact, err := os.ReadFile(artifactPath)
	if err != nil {
		return Manifest{}, "", Release{}, err
	}
	digest := sha256.Sum256(artifact)
	if hex.EncodeToString(digest[:]) != strings.ToLower(release.ArtifactSHA256) {
		return Manifest{}, "", Release{}, errors.New("installed release artifact does not match signed SHA-256")
	}
	expectedContentDigest, err := packageArchiveContentSHA256(artifact)
	if err != nil {
		return Manifest{}, "", Release{}, fmt.Errorf("derive signed extension content identity: %w", err)
	}
	actualContentDigest, err := packageContentSHA256(root)
	if err != nil {
		return Manifest{}, "", Release{}, err
	}
	if actualContentDigest != expectedContentDigest {
		return Manifest{}, "", Release{}, errors.New("installed extension package does not match signed artifact content")
	}
	manifest, err := validateInstalledPackage(root, key, version)
	if err != nil {
		return Manifest{}, "", Release{}, fmt.Errorf("validate installed signed extension package: %w", err)
	}
	if !reflect.DeepEqual(manifest, release.Manifest) {
		return Manifest{}, "", Release{}, errors.New("installed manifest does not match signed release manifest")
	}
	return manifest, expectedContentDigest, release, nil
}

func (m *Manager) sourceForSignedRelease(key, signingKeyID string) (tuttitypes.AgentExtensionSource, bool) {
	for _, source := range m.Sources {
		if source.Key == key && source.SigningKeyID == signingKeyID && strings.TrimSpace(source.SigningPublicKey) != "" {
			return source, true
		}
	}
	return tuttitypes.AgentExtensionSource{}, false
}
