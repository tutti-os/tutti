package agentextension

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"time"

	"golang.org/x/mod/semver"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

const (
	versionsSchema = "tutti.agent.versions.v1"
	releaseSchema  = "tutti.agent.release.v1"
	maxIndexBytes  = 2 << 20
	maxArtifact    = 20 << 20
)

type Versions struct {
	SchemaVersion string          `json:"schemaVersion"`
	AgentKey      string          `json:"agentKey"`
	Versions      []VersionRecord `json:"versions"`
}

type VersionRecord struct {
	Version                  string   `json:"version"`
	MinTuttiVersion          string   `json:"minTuttiVersion"`
	RequiredHostCapabilities []string `json:"requiredHostCapabilities"`
	Status                   string   `json:"status"`
	Release                  Release  `json:"release"`
}

type Release struct {
	SchemaVersion     string           `json:"schemaVersion"`
	AgentKey          string           `json:"agentKey"`
	Version           string           `json:"version"`
	Manifest          Manifest         `json:"manifest"`
	ArtifactURL       string           `json:"artifactUrl"`
	ArtifactSHA256    string           `json:"artifactSha256"`
	ArtifactSizeBytes int64            `json:"artifactSizeBytes"`
	PublishedAt       string           `json:"publishedAt"`
	GitSHA            string           `json:"gitSha"`
	Signature         ReleaseSignature `json:"signature"`
	signedPayload     []byte
	signedDocument    []byte
}

type ReleaseSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

func (release *Release) UnmarshalJSON(data []byte) error {
	type releaseWire Release
	var wire releaseWire
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return err
	}
	payload, err := releasePayloadFromJSON(data)
	if err != nil {
		return err
	}
	*release = Release(wire)
	release.signedPayload = payload
	release.signedDocument = append([]byte(nil), data...)
	return nil
}

// MarshalJSON preserves the wire shape that was covered by the release
// signature. In particular, optional zero-value manifest structs cannot be
// reintroduced when a release record is written to local state and later
// reverified.
func (release Release) MarshalJSON() ([]byte, error) {
	if len(release.signedDocument) > 0 {
		var original Release
		if err := json.Unmarshal(release.signedDocument, &original); err == nil &&
			sameReleaseWire(release, original) {
			return append([]byte(nil), release.signedDocument...), nil
		}
	}
	type releaseWire Release
	return json.Marshal(releaseWire(release))
}

func sameReleaseWire(left, right Release) bool {
	return left.SchemaVersion == right.SchemaVersion &&
		left.AgentKey == right.AgentKey &&
		left.Version == right.Version &&
		reflect.DeepEqual(left.Manifest, right.Manifest) &&
		left.ArtifactURL == right.ArtifactURL &&
		left.ArtifactSHA256 == right.ArtifactSHA256 &&
		left.ArtifactSizeBytes == right.ArtifactSizeBytes &&
		left.PublishedAt == right.PublishedAt &&
		left.GitSHA == right.GitSHA &&
		left.Signature == right.Signature
}

func (m *Manager) getJSON(ctx context.Context, rawURL string, limit int64, target any) error {
	data, err := m.getBytes(ctx, rawURL, limit)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func (m *Manager) getBytes(ctx context.Context, rawURL string, limit int64) ([]byte, error) {
	if !strings.HasPrefix(rawURL, "https://") {
		return nil, errors.New("agent extension URL must use HTTPS")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	client := m.Client
	if client == nil {
		client = httpx.NewClient(30 * time.Second)
	}
	client = httpsOnlyRedirectClient(client, errors.New("agent extension download redirected away from HTTPS"))
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.Request == nil || response.Request.URL.Scheme != "https" {
		return nil, errors.New("agent extension download redirected away from HTTPS")
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("agent extension download returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("agent extension download exceeds size limit")
	}
	return data, nil
}

func httpsOnlyRedirectClient(client *http.Client, downgradeError error) *http.Client {
	clone := *client
	previous := client.CheckRedirect
	clone.CheckRedirect = func(request *http.Request, via []*http.Request) error {
		if request == nil || request.URL == nil || !strings.EqualFold(request.URL.Scheme, "https") {
			return downgradeError
		}
		if previous != nil {
			if err := previous(request, via); err != nil {
				return err
			}
			if request.URL == nil || !strings.EqualFold(request.URL.Scheme, "https") {
				return downgradeError
			}
			return nil
		}
		if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		return nil
	}
	return &clone
}

func selectVersion(document Versions, key string, appVersion string) (VersionRecord, error) {
	if document.SchemaVersion != versionsSchema || document.AgentKey != key {
		return VersionRecord{}, errors.New("invalid extension versions identity")
	}
	candidates := append([]VersionRecord(nil), document.Versions...)
	sort.SliceStable(candidates, func(i, j int) bool { return semver.Compare("v"+candidates[i].Version, "v"+candidates[j].Version) > 0 })
	for _, record := range candidates {
		if record.Status != "active" || !validSemver(record.Version) || !validSemver(record.MinTuttiVersion) {
			continue
		}
		if semver.Compare("v"+appVersion, "v"+record.MinTuttiVersion) < 0 {
			continue
		}
		if len(record.RequiredHostCapabilities) == 0 {
			return record, nil
		}
	}
	return VersionRecord{}, errors.New("no compatible active extension version")
}

func verifyRelease(release Release, source tuttitypes.AgentExtensionSource) error {
	if release.SchemaVersion != releaseSchema || release.AgentKey != source.Key || release.Version != release.Manifest.Version {
		return errors.New("signed release identity is invalid")
	}
	if release.Signature.Algorithm != "ed25519" || release.Signature.KeyID != source.SigningKeyID {
		return errors.New("signed release key identity is invalid")
	}
	block, _ := pem.Decode([]byte(source.SigningPublicKey))
	if block == nil {
		return errors.New("extension signing public key is invalid")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return err
	}
	publicKey, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return errors.New("extension signing key must be Ed25519")
	}
	payload, err := releasePayload(release)
	if err != nil {
		return err
	}
	signature, err := base64.StdEncoding.DecodeString(release.Signature.Value)
	if err != nil || !ed25519.Verify(publicKey, payload, signature) {
		return errors.New("agent extension release signature is invalid")
	}
	return nil
}

func releasePayload(release Release) ([]byte, error) {
	if len(release.signedPayload) > 0 {
		return release.signedPayload, nil
	}
	raw, err := json.Marshal(release)
	if err != nil {
		return nil, err
	}
	return releasePayloadFromJSON(raw)
}

func releasePayloadFromJSON(raw []byte) ([]byte, error) {
	var unsigned map[string]any
	if err := json.Unmarshal(raw, &unsigned); err != nil {
		return nil, err
	}
	delete(unsigned, "signature")
	return json.Marshal(unsigned)
}
