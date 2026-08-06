package managedruntime

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/httpx"
)

const (
	ConnectorRuntimeCatalogSchemaVersion = "tutti.app.runtimes.v3"
	ConnectorNodeProfile                 = "connector-node-static"
	ConnectorPythonProfile               = "connector-python-static"
	connectorRuntimeReceiptSchemaVersion = "tutti.connector.runtime.receipt.v1"
	connectorRuntimeTrustSchemaVersion   = "tutti.connector.runtime.trust.v1"
	connectorRuntimeReceiptDir           = ".tutti-connector-receipts"
	maxConnectorRuntimeReceiptBytes      = 4 * 1024 * 1024
	maxConnectorRuntimeCatalogTTL        = 7 * 24 * time.Hour
	connectorRuntimeClockSkew            = 5 * time.Minute
)

// ConnectorRuntimeResolverConfig is supplied by the signed application
// bundle. It intentionally has no environment callback: a connector cannot
// redirect either the catalog or trust key through daemon environment state.
type ConnectorRuntimeResolverConfig struct {
	RuntimeRoot        string
	CatalogURL         string
	CatalogPublicKey   ed25519.PublicKey
	CatalogKeyID       string
	ApplicationVersion string
	HTTPClient         *http.Client
	Now                func() time.Time
}

type ConnectorRuntimeResolver struct {
	runtimeRoot        string
	catalogURL         string
	publicKey          ed25519.PublicKey
	keyID              string
	httpClient         *http.Client
	applicationVersion string
	now                func() time.Time

	readCatalog func(context.Context) ([]byte, error)
	mu          sync.Mutex
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

type connectorCatalogEnvelope struct {
	SchemaVersion string                    `json:"schemaVersion"`
	Payload       string                    `json:"payload"`
	Signature     connectorCatalogSignature `json:"signature"`
}

type connectorCatalogSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

type connectorCatalogPayload struct {
	Sequence           uint64                            `json:"sequence"`
	IssuedAt           string                            `json:"issuedAt"`
	NextUpdateAt       string                            `json:"nextUpdateAt"`
	ExpiresAt          string                            `json:"expiresAt"`
	ApplicationVersion string                            `json:"applicationVersion"`
	Runtimes           map[string]appRuntimeCatalogEntry `json:"runtimes"`
}

type connectorRuntimeTrustState struct {
	SchemaVersion string `json:"schemaVersion"`
	Sequence      uint64 `json:"sequence"`
	PayloadSHA256 string `json:"payloadSha256"`
	WallHighWater string `json:"wallHighWater"`
}

type verifiedConnectorCatalog struct {
	payload       connectorCatalogPayload
	payloadSHA256 string
	issuedAt      time.Time
	nextUpdateAt  time.Time
	expiresAt     time.Time
}

type connectorRuntimeReceipt struct {
	SchemaVersion    string                         `json:"schemaVersion"`
	CatalogEnvelope  connectorCatalogEnvelope       `json:"catalogEnvelope"`
	Platform         string                         `json:"platform"`
	Profile          string                         `json:"profile"`
	ABI              string                         `json:"abi"`
	Components       map[string]string              `json:"components"`
	ComponentDigests map[string]string              `json:"componentDigests"`
	Executables      map[string]ConnectorExecutable `json:"executables"`
}

func NewConnectorRuntimeResolver(config ConnectorRuntimeResolverConfig) (*ConnectorRuntimeResolver, error) {
	root := strings.TrimSpace(config.RuntimeRoot)
	if root == "" || !filepath.IsAbs(root) {
		return nil, errors.New("connector managed runtime root must be absolute")
	}
	catalogURL := strings.TrimSpace(config.CatalogURL)
	parsedURL, err := url.Parse(catalogURL)
	if err != nil || parsedURL.Scheme != "https" || parsedURL.Host == "" {
		return nil, errors.New("connector managed runtime catalog must use an app-pinned HTTPS URL")
	}
	if len(config.CatalogPublicKey) != ed25519.PublicKeySize || strings.TrimSpace(config.CatalogKeyID) == "" {
		return nil, errors.New("connector managed runtime catalog public key and key id are required")
	}
	if strings.TrimSpace(config.ApplicationVersion) == "" {
		return nil, errors.New("connector managed runtime application version is required")
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return &ConnectorRuntimeResolver{
		runtimeRoot:        filepath.Join(filepath.Clean(root), "connector-v3", appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH)),
		catalogURL:         catalogURL,
		publicKey:          append(ed25519.PublicKey(nil), config.CatalogPublicKey...),
		keyID:              strings.TrimSpace(config.CatalogKeyID),
		httpClient:         config.HTTPClient,
		applicationVersion: strings.TrimSpace(config.ApplicationVersion),
		now:                now,
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
	resolver.mu.Lock()
	defer resolver.mu.Unlock()

	if receipt, err := resolver.readAndVerifyReceipt(profile, true); err == nil {
		return resolver.resolvedFromReceipt(receipt)
	}

	envelopeBytes, err := resolver.catalogBytes(ctx)
	if err != nil {
		return ResolvedConnectorRuntime{}, err
	}
	envelope, verified, err := resolver.verifyCatalogEnvelope(envelopeBytes)
	if err != nil {
		return ResolvedConnectorRuntime{}, err
	}
	if err := resolver.acceptCatalogTrust(verified); err != nil {
		return ResolvedConnectorRuntime{}, err
	}
	payload := verified.payload
	platform := appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH)
	entry, ok := payload.Runtimes[platform]
	if !ok {
		return ResolvedConnectorRuntime{}, fmt.Errorf("signed connector runtime catalog does not contain platform %q", platform)
	}
	componentNames, err := appRuntimeProfileComponentNames(entry, profile)
	if err != nil {
		return ResolvedConnectorRuntime{}, err
	}
	if err := validateConnectorProfileComponents(profile, componentNames); err != nil {
		return ResolvedConnectorRuntime{}, err
	}
	// Always replace every component after a missing or invalid signed receipt.
	// This prevents an unsigned v2 cache or environment-selected runtime tree
	// from being promoted into the production connector trust boundary.
	downloader := DefaultResolver{
		RuntimeRoot: resolver.runtimeRoot,
		Environ:     func() []string { return []string{} },
		HTTPClient:  resolver.httpClient,
	}
	if err := downloader.downloadRuntime(ctx, resolver.runtimeRoot, entry, componentNames); err != nil {
		return ResolvedConnectorRuntime{}, err
	}
	receipt, err := resolver.buildReceipt(envelope, entry, profile, componentNames)
	if err != nil {
		return ResolvedConnectorRuntime{}, err
	}
	if err := resolver.writeReceipt(receipt); err != nil {
		return ResolvedConnectorRuntime{}, err
	}
	return resolver.resolvedFromReceipt(receipt)
}

// VerifyLaunch re-reads the signed receipt and hashes the selected executable.
// Callers use the returned identity immediately before ProcessTransport.Start.
func (resolver *ConnectorRuntimeResolver) VerifyLaunch(profile, runtimeName string) (ConnectorExecutable, error) {
	if resolver == nil {
		return ConnectorExecutable{}, errors.New("connector managed runtime resolver is nil")
	}
	profile, err := validatedConnectorProfile(profile)
	if err != nil {
		return ConnectorExecutable{}, err
	}
	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	receipt, err := resolver.readAndVerifyReceipt(profile, false)
	if err != nil {
		return ConnectorExecutable{}, err
	}
	resolved, err := resolver.resolvedFromReceipt(receipt)
	if err != nil {
		return ConnectorExecutable{}, err
	}
	switch strings.TrimSpace(runtimeName) {
	case "node":
		if resolved.Node != nil {
			return *resolved.Node, nil
		}
	case "python":
		if resolved.Python != nil {
			return *resolved.Python, nil
		}
	}
	return ConnectorExecutable{}, fmt.Errorf("runtime %q is not present in connector profile %q", runtimeName, profile)
}

func (resolver *ConnectorRuntimeResolver) catalogBytes(ctx context.Context) ([]byte, error) {
	if resolver.readCatalog != nil {
		data, err := resolver.readCatalog(ctx)
		if err != nil {
			return nil, err
		}
		if len(data) > 2*1024*1024 {
			return nil, errors.New("signed connector runtime catalog exceeds maximum size")
		}
		return data, nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, resolver.catalogURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create signed connector runtime catalog request: %w", err)
	}
	response, err := resolver.client().Do(request)
	if err != nil {
		return nil, fmt.Errorf("download signed connector runtime catalog: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("download signed connector runtime catalog: unexpected status %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024+1))
	if err != nil {
		return nil, fmt.Errorf("read signed connector runtime catalog: %w", err)
	}
	if len(data) > 2*1024*1024 {
		return nil, errors.New("signed connector runtime catalog exceeds maximum size")
	}
	return data, nil
}

func (resolver *ConnectorRuntimeResolver) verifyCatalogEnvelope(data []byte) (connectorCatalogEnvelope, verifiedConnectorCatalog, error) {
	var envelope connectorCatalogEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return envelope, verifiedConnectorCatalog{}, fmt.Errorf("parse signed connector runtime catalog: %w", err)
	}
	if envelope.SchemaVersion != ConnectorRuntimeCatalogSchemaVersion ||
		envelope.Signature.Algorithm != "ed25519" ||
		envelope.Signature.KeyID != resolver.keyID {
		return envelope, verifiedConnectorCatalog{}, errors.New("signed connector runtime catalog envelope is unsupported")
	}
	payloadBytes, err := base64.StdEncoding.DecodeString(envelope.Payload)
	if err != nil {
		return envelope, verifiedConnectorCatalog{}, errors.New("signed connector runtime catalog payload is invalid")
	}
	signature, err := base64.StdEncoding.DecodeString(envelope.Signature.Value)
	if err != nil || !ed25519.Verify(resolver.publicKey, payloadBytes, signature) {
		return envelope, verifiedConnectorCatalog{}, errors.New("signed connector runtime catalog signature is invalid")
	}
	var payload connectorCatalogPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return envelope, verifiedConnectorCatalog{}, fmt.Errorf("parse signed connector runtime catalog payload: %w", err)
	}
	verified, err := resolver.validateCatalogPayload(payload, payloadBytes)
	if err != nil {
		return envelope, verifiedConnectorCatalog{}, err
	}
	for platform, entry := range payload.Runtimes {
		if err := validateManagedAppRuntimeCatalogEntry(platform, entry); err != nil {
			return envelope, verifiedConnectorCatalog{}, err
		}
		for _, profile := range []string{ConnectorNodeProfile, ConnectorPythonProfile} {
			if _, present := entry.Profiles[profile]; !present {
				continue
			}
			language := connectorProfileRuntimeName(profile)
			abi := strings.TrimSpace(entry.ProfileABIs[profile])
			if !strings.HasPrefix(abi, language) || !strings.HasSuffix(abi, platform) {
				return envelope, verifiedConnectorCatalog{}, fmt.Errorf("signed connector runtime profile %q has no exact ABI for %q", profile, platform)
			}
		}
	}
	return envelope, verified, nil
}

func (resolver *ConnectorRuntimeResolver) validateCatalogPayload(payload connectorCatalogPayload, payloadBytes []byte) (verifiedConnectorCatalog, error) {
	if payload.Sequence == 0 || len(payload.Runtimes) == 0 {
		return verifiedConnectorCatalog{}, errors.New("signed connector runtime catalog identity is invalid")
	}
	if payload.ApplicationVersion != resolver.applicationVersion {
		return verifiedConnectorCatalog{}, fmt.Errorf("signed connector runtime catalog targets application version %q, want %q", payload.ApplicationVersion, resolver.applicationVersion)
	}
	issuedAt, err := time.Parse(time.RFC3339, payload.IssuedAt)
	if err != nil {
		return verifiedConnectorCatalog{}, errors.New("signed connector runtime catalog issuedAt is invalid")
	}
	nextUpdateAt, err := time.Parse(time.RFC3339, payload.NextUpdateAt)
	if err != nil {
		return verifiedConnectorCatalog{}, errors.New("signed connector runtime catalog nextUpdateAt is invalid")
	}
	expiresAt, err := time.Parse(time.RFC3339, payload.ExpiresAt)
	if err != nil {
		return verifiedConnectorCatalog{}, errors.New("signed connector runtime catalog expiresAt is invalid")
	}
	if !issuedAt.Before(nextUpdateAt) || nextUpdateAt.After(expiresAt) || expiresAt.Sub(issuedAt) > maxConnectorRuntimeCatalogTTL {
		return verifiedConnectorCatalog{}, errors.New("signed connector runtime catalog validity window is invalid")
	}
	digest := sha256.Sum256(payloadBytes)
	verified := verifiedConnectorCatalog{payload: payload, payloadSHA256: hex.EncodeToString(digest[:]), issuedAt: issuedAt, nextUpdateAt: nextUpdateAt, expiresAt: expiresAt}
	state, err := resolver.readCatalogTrustState()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return verifiedConnectorCatalog{}, err
	}
	effectiveNow := resolver.now().UTC()
	if highWater, parseErr := time.Parse(time.RFC3339, state.WallHighWater); parseErr == nil && highWater.After(effectiveNow) {
		effectiveNow = highWater
	}
	if issuedAt.After(effectiveNow.Add(connectorRuntimeClockSkew)) || !effectiveNow.Before(expiresAt) {
		return verifiedConnectorCatalog{}, errors.New("signed connector runtime catalog is not currently valid")
	}
	if state.Sequence > payload.Sequence {
		return verifiedConnectorCatalog{}, errors.New("signed connector runtime catalog sequence rolled back")
	}
	if state.Sequence == payload.Sequence && state.PayloadSHA256 != "" && state.PayloadSHA256 != verified.payloadSHA256 {
		return verifiedConnectorCatalog{}, errors.New("signed connector runtime catalog sequence equivocated")
	}
	return verified, nil
}

func (resolver *ConnectorRuntimeResolver) acceptCatalogTrust(verified verifiedConnectorCatalog) error {
	state, err := resolver.readCatalogTrustState()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	now := resolver.now().UTC()
	if highWater, parseErr := time.Parse(time.RFC3339, state.WallHighWater); parseErr == nil && highWater.After(now) {
		now = highWater
	}
	state = connectorRuntimeTrustState{
		SchemaVersion: connectorRuntimeTrustSchemaVersion,
		Sequence:      verified.payload.Sequence,
		PayloadSHA256: verified.payloadSHA256,
		WallHighWater: now.Format(time.RFC3339),
	}
	return resolver.writeCatalogTrustState(state)
}

func (resolver *ConnectorRuntimeResolver) buildReceipt(
	envelope connectorCatalogEnvelope,
	entry appRuntimeCatalogEntry,
	profile string,
	componentNames []string,
) (connectorRuntimeReceipt, error) {
	receipt := connectorRuntimeReceipt{
		SchemaVersion:    connectorRuntimeReceiptSchemaVersion,
		CatalogEnvelope:  envelope,
		Platform:         appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH),
		Profile:          profile,
		ABI:              strings.TrimSpace(entry.ProfileABIs[profile]),
		Components:       make(map[string]string, len(componentNames)),
		ComponentDigests: make(map[string]string, len(componentNames)),
		Executables:      make(map[string]ConnectorExecutable),
	}
	for _, name := range componentNames {
		component := entry.Components[name]
		receipt.Components[name] = component.Version
		receipt.ComponentDigests[name] = strings.ToLower(component.ArtifactSHA256)
	}
	if containsString(componentNames, "node") {
		executable, err := resolver.signedExecutable(entry.Components["node"], "node", "node")
		if err != nil {
			return connectorRuntimeReceipt{}, err
		}
		receipt.Executables["node"] = executable
	}
	if containsString(componentNames, "python") {
		executable, err := resolver.signedExecutable(entry.Components["python"], "python", "python")
		if err != nil {
			return connectorRuntimeReceipt{}, err
		}
		receipt.Executables["python"] = executable
	}
	return receipt, nil
}

func (resolver *ConnectorRuntimeResolver) readAndVerifyReceipt(profile string, requireFresh bool) (connectorRuntimeReceipt, error) {
	file, err := os.Open(resolver.receiptPath(profile))
	if err != nil {
		return connectorRuntimeReceipt{}, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maxConnectorRuntimeReceiptBytes+1))
	if err != nil {
		return connectorRuntimeReceipt{}, fmt.Errorf("read connector runtime receipt: %w", err)
	}
	if len(data) > maxConnectorRuntimeReceiptBytes {
		return connectorRuntimeReceipt{}, errors.New("connector runtime receipt exceeds maximum size")
	}
	var receipt connectorRuntimeReceipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		return connectorRuntimeReceipt{}, fmt.Errorf("parse connector runtime receipt: %w", err)
	}
	if receipt.SchemaVersion != connectorRuntimeReceiptSchemaVersion || receipt.ABI == "" ||
		receipt.Profile != profile ||
		receipt.Platform != appRuntimePlatformArch(runtime.GOOS, runtime.GOARCH) {
		return connectorRuntimeReceipt{}, errors.New("connector runtime receipt identity is invalid")
	}
	envelopeBytes, _ := json.Marshal(receipt.CatalogEnvelope)
	_, verified, err := resolver.verifyCatalogEnvelope(envelopeBytes)
	if err != nil {
		return connectorRuntimeReceipt{}, err
	}
	if requireFresh && !resolver.now().UTC().Before(verified.nextUpdateAt) {
		return connectorRuntimeReceipt{}, errors.New("connector runtime receipt requires a fresh signed catalog")
	}
	payload := verified.payload
	entry, ok := payload.Runtimes[receipt.Platform]
	if !ok {
		return connectorRuntimeReceipt{}, errors.New("connector runtime receipt platform is not signed")
	}
	if receipt.ABI != strings.TrimSpace(entry.ProfileABIs[profile]) {
		return connectorRuntimeReceipt{}, errors.New("connector runtime receipt ABI is not signed")
	}
	componentNames, err := appRuntimeProfileComponentNames(entry, profile)
	if err != nil {
		return connectorRuntimeReceipt{}, err
	}
	if err := validateConnectorProfileComponents(profile, componentNames); err != nil {
		return connectorRuntimeReceipt{}, err
	}
	if len(receipt.Components) != len(componentNames) || len(receipt.ComponentDigests) != len(componentNames) {
		return connectorRuntimeReceipt{}, errors.New("connector runtime receipt component set is invalid")
	}
	for _, name := range componentNames {
		component := entry.Components[name]
		if receipt.Components[name] != component.Version ||
			!strings.EqualFold(receipt.ComponentDigests[name], component.ArtifactSHA256) {
			return connectorRuntimeReceipt{}, errors.New("connector runtime receipt component is not signed")
		}
	}
	expectedRuntimeName := connectorProfileRuntimeName(profile)
	if len(receipt.Executables) != 1 {
		return connectorRuntimeReceipt{}, errors.New("connector runtime receipt executable set is invalid")
	}
	for runtimeName, recorded := range receipt.Executables {
		if runtimeName != expectedRuntimeName {
			return connectorRuntimeReceipt{}, errors.New("connector runtime receipt executable set is invalid")
		}
		componentName := runtimeName
		component, ok := entry.Components[componentName]
		if !ok {
			return connectorRuntimeReceipt{}, errors.New("connector runtime receipt executable component is not signed")
		}
		signed, err := resolver.signedExecutable(component, componentName, runtimeName)
		if err != nil || recorded != signed {
			return connectorRuntimeReceipt{}, errors.New("connector runtime receipt executable identity is not signed")
		}
	}
	if err := resolver.requireAcceptedCatalogTrust(verified); err != nil {
		return connectorRuntimeReceipt{}, err
	}
	if err := resolver.acceptCatalogTrust(verified); err != nil {
		return connectorRuntimeReceipt{}, err
	}
	return receipt, nil
}

func (resolver *ConnectorRuntimeResolver) requireAcceptedCatalogTrust(verified verifiedConnectorCatalog) error {
	state, err := resolver.readCatalogTrustState()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return errors.New("connector runtime receipt has no durable catalog trust state")
		}
		return err
	}
	if state.Sequence != verified.payload.Sequence || state.PayloadSHA256 != verified.payloadSHA256 {
		return errors.New("connector runtime receipt does not match durable catalog trust state")
	}
	return nil
}

func (resolver *ConnectorRuntimeResolver) resolvedFromReceipt(receipt connectorRuntimeReceipt) (ResolvedConnectorRuntime, error) {
	result := ResolvedConnectorRuntime{
		Root:       resolver.runtimeRoot,
		Profile:    receipt.Profile,
		ABI:        receipt.ABI,
		Components: cloneStringMap(receipt.Components),
	}
	for name, expected := range receipt.Executables {
		actual, err := executableIdentity(expected.Path)
		if err != nil || actual.SHA256 != expected.SHA256 || actual.SizeBytes != expected.SizeBytes {
			return ResolvedConnectorRuntime{}, fmt.Errorf("connector runtime %s launch identity is invalid", name)
		}
		switch name {
		case "node":
			copy := actual
			result.Node = &copy
		case "python":
			copy := actual
			result.Python = &copy
		}
	}
	return result, nil
}

func (resolver *ConnectorRuntimeResolver) writeReceipt(receipt connectorRuntimeReceipt) error {
	path := resolver.receiptPath(receipt.Profile)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".receipt-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func (resolver *ConnectorRuntimeResolver) readCatalogTrustState() (connectorRuntimeTrustState, error) {
	data, err := os.ReadFile(resolver.catalogTrustStatePath())
	if err != nil {
		return connectorRuntimeTrustState{}, err
	}
	var state connectorRuntimeTrustState
	if err := json.Unmarshal(data, &state); err != nil {
		return connectorRuntimeTrustState{}, fmt.Errorf("parse connector runtime catalog trust state: %w", err)
	}
	if state.SchemaVersion != connectorRuntimeTrustSchemaVersion || state.Sequence == 0 || !isSHA256Hex(state.PayloadSHA256) {
		return connectorRuntimeTrustState{}, errors.New("connector runtime catalog trust state is invalid")
	}
	if _, err := time.Parse(time.RFC3339, state.WallHighWater); err != nil {
		return connectorRuntimeTrustState{}, errors.New("connector runtime catalog trust wall high water is invalid")
	}
	return state, nil
}

func (resolver *ConnectorRuntimeResolver) writeCatalogTrustState(state connectorRuntimeTrustState) error {
	path := resolver.catalogTrustStatePath()
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".catalog-trust-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	if directoryHandle, err := os.Open(directory); err == nil {
		_ = directoryHandle.Sync()
		_ = directoryHandle.Close()
	}
	return nil
}

func (resolver *ConnectorRuntimeResolver) catalogTrustStatePath() string {
	return filepath.Join(resolver.runtimeRoot, connectorRuntimeReceiptDir, "catalog-trust.json")
}

func (resolver *ConnectorRuntimeResolver) receiptPath(profile string) string {
	return filepath.Join(resolver.runtimeRoot, connectorRuntimeReceiptDir, profile+".json")
}

func validatedConnectorProfile(profile string) (string, error) {
	profile = strings.TrimSpace(profile)
	if profile != ConnectorNodeProfile && profile != ConnectorPythonProfile {
		return "", fmt.Errorf("unsupported connector managed runtime profile %q", profile)
	}
	return profile, nil
}

func connectorProfileRuntimeName(profile string) string {
	if profile == ConnectorPythonProfile {
		return "python"
	}
	return "node"
}

func validateConnectorProfileComponents(profile string, componentNames []string) error {
	want := connectorProfileRuntimeName(profile)
	if len(componentNames) != 1 || componentNames[0] != want {
		return fmt.Errorf("signed connector runtime profile %q must contain only component %q", profile, want)
	}
	return nil
}

func (resolver *ConnectorRuntimeResolver) client() *http.Client {
	if resolver.httpClient != nil {
		return resolver.httpClient
	}
	return httpx.Default()
}

func executableIdentity(path string) (ConnectorExecutable, error) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return ConnectorExecutable{}, fmt.Errorf("connector runtime executable is unavailable at %s", path)
	}
	digest, size, err := fileSHA256AndSize(path)
	if err != nil {
		return ConnectorExecutable{}, err
	}
	return ConnectorExecutable{Path: path, SHA256: digest, SizeBytes: size}, nil
}

func (resolver *ConnectorRuntimeResolver) signedExecutable(
	component appRuntimeCatalogComponent,
	componentName string,
	runtimeName string,
) (ConnectorExecutable, error) {
	declared, ok := component.Executables[runtimeName]
	if !ok || !isSHA256Hex(declared.SHA256) || declared.SizeBytes <= 0 {
		return ConnectorExecutable{}, fmt.Errorf("signed connector runtime component %q has no valid %q executable identity", componentName, runtimeName)
	}
	relative := filepath.Clean(filepath.FromSlash(strings.TrimSpace(declared.Path)))
	if relative == "." || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return ConnectorExecutable{}, fmt.Errorf("signed connector runtime executable path %q is invalid", declared.Path)
	}
	path := filepath.Join(resolver.runtimeRoot, componentName, relative)
	actual, err := executableIdentity(path)
	if err != nil {
		return ConnectorExecutable{}, err
	}
	if !strings.EqualFold(actual.SHA256, declared.SHA256) || actual.SizeBytes != declared.SizeBytes {
		return ConnectorExecutable{}, fmt.Errorf("signed connector runtime %s launch identity is invalid", runtimeName)
	}
	return actual, nil
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func cloneStringMap(values map[string]string) map[string]string {
	cloned := make(map[string]string, len(values))
	for key, value := range values {
		cloned[key] = value
	}
	return cloned
}
