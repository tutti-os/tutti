package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/host"
	marketartifact "github.com/tutti-os/tutti/packages/connector/runtime/artifact"
)

const (
	remoteArchiveReceiptSchema = "tutti.connector.cli-installation.v2"
	remoteArchiveReceiptFile   = ".tutti-remote-archive-receipt.json"
	maxRemoteArchiveRedirects  = 3
)

type RemoteArchiveInstallerConfig struct {
	RootDir                              string
	HTTPClient                           *http.Client
	Limits                               marketartifact.Limits
	Timeout                              time.Duration
	LookupIP                             func(context.Context, string) ([]net.IPAddr, error)
	UnsafeAllowUnpinnedTransportForTests bool
}

type RemoteArchiveInstaller struct {
	rootDir    string
	httpClient *http.Client
	limits     marketartifact.Limits
	timeout    time.Duration
	lookupIP   func(context.Context, string) ([]net.IPAddr, error)
	mu         sync.Mutex
	lanes      map[string]*sync.Mutex
	cacheLanes map[string]*sync.Mutex
	slots      chan struct{}
	rename     func(string, string) error
	syncDir    func(string) error
}

type remoteArchivePinnedAddresses struct {
	host      string
	addresses []net.IPAddr
}
type remoteArchivePinnedAddressesKey struct{}

var _ market.CLIInstallationManager = (*RemoteArchiveInstaller)(nil)

func NewRemoteArchiveInstaller(config RemoteArchiveInstallerConfig) (*RemoteArchiveInstaller, error) {
	root := filepath.Clean(strings.TrimSpace(config.RootDir))
	if !filepath.IsAbs(root) {
		return nil, errors.New("connector remote archive root must be absolute")
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{}
	}
	clientCopy := *client
	clientCopy.Jar = nil
	clientCopy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	limits := config.Limits
	if limits == (marketartifact.Limits{}) {
		limits = marketartifact.DefaultLimits()
	}
	lookup := config.LookupIP
	if lookup == nil {
		lookup = net.DefaultResolver.LookupIPAddr
	}
	var transport *http.Transport
	switch configured := clientCopy.Transport.(type) {
	case nil:
		defaultTransport, ok := http.DefaultTransport.(*http.Transport)
		if !ok {
			return nil, errors.New("connector remote archive default HTTP transport is unsupported")
		}
		transport = defaultTransport.Clone()
	case *http.Transport:
		transport = configured.Clone()
	default:
		if !config.UnsafeAllowUnpinnedTransportForTests {
			return nil, errors.New("connector remote archive HTTP transport must support pinned dialing")
		}
	}
	if transport != nil {
		// DialTLS is deprecated, but callers can still set it and bypass DialContext.
		//nolint:staticcheck // Reject both TLS dial hooks to preserve DNS pinning.
		if transport.DialTLSContext != nil || transport.DialTLS != nil {
			return nil, errors.New("connector remote archive HTTP transport must not override TLS dialing")
		}
		if transport.TLSClientConfig != nil {
			if transport.TLSClientConfig.InsecureSkipVerify {
				return nil, errors.New("connector remote archive HTTP transport must verify TLS")
			}
			transport.TLSClientConfig = transport.TLSClientConfig.Clone()
			transport.TLSClientConfig.ServerName = ""
		}
		// A proxy resolves the CONNECT target independently and would break the
		// binding between validation and the origin socket established below.
		transport.Proxy = nil
		baseDial := (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext
		transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
			pinned, _ := ctx.Value(remoteArchivePinnedAddressesKey{}).(remoteArchivePinnedAddresses)
			host, port, splitErr := net.SplitHostPort(address)
			if splitErr != nil || !strings.EqualFold(host, pinned.host) || len(pinned.addresses) == 0 {
				return nil, errors.New("connector remote archive dial is not bound to validated DNS addresses")
			}
			var dialErr error
			for _, candidate := range pinned.addresses {
				connection, err := baseDial(ctx, network, net.JoinHostPort(candidate.IP.String(), port))
				if err == nil {
					return connection, nil
				}
				dialErr = errors.Join(dialErr, err)
			}
			return nil, dialErr
		}
		clientCopy.Transport = transport
	}
	return &RemoteArchiveInstaller{rootDir: root, httpClient: &clientCopy, limits: limits, timeout: timeout,
		lookupIP: lookup, lanes: make(map[string]*sync.Mutex), cacheLanes: make(map[string]*sync.Mutex), slots: make(chan struct{}, 4),
		rename: os.Rename, syncDir: marketartifact.SyncDirectory}, nil
}

func (installer *RemoteArchiveInstaller) InstallCLI(ctx context.Context, request market.InstallCLIRequest) (market.CLIInstallationReceipt, error) {
	if installer == nil || runtime.GOOS == "windows" {
		return market.CLIInstallationReceipt{}, errors.New("connector remote archive installation is unavailable on this platform")
	}
	if err := market.ValidateReleaseShape(request.Release); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	managed, cli, install, err := remoteArchiveIntent(request.Release)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	if !safeCLIPathSegment(request.OperationID) {
		return market.CLIInstallationReceipt{}, errors.New("connector remote archive operation id is invalid")
	}
	unlock := installer.lock(request.Release.ConnectorKey)
	defer unlock()
	select {
	case installer.slots <- struct{}{}:
		defer func() { <-installer.slots }()
	case <-ctx.Done():
		return market.CLIInstallationReceipt{}, ctx.Err()
	}

	target := installer.installRoot(request.Release)
	if receipt, verifyErr := installer.readAndVerifyReceipt(request.Release, target); verifyErr == nil {
		receipt.OperationID = request.OperationID
		return receipt, nil
	}
	archivePath, err := installer.prepareArchive(ctx, install.Source)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	staging := filepath.Join(installer.rootDir, "staging", request.OperationID)
	if !pathWithin(installer.rootDir, staging) {
		return market.CLIInstallationReceipt{}, errors.New("connector remote archive staging path escapes root")
	}
	if err := marketartifact.RemoveAllWithin(installer.rootDir, staging); err != nil {
		return market.CLIInstallationReceipt{}, fmt.Errorf("clean connector remote archive staging: %w", err)
	}
	if err := createRemoteArchiveDirectory(installer.rootDir, staging); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	defer func() {
		_ = removeRemoteArchiveTree(installer.rootDir, staging)
	}()
	extracted := filepath.Join(staging, "extracted")
	if err := createRemoteArchiveDirectory(installer.rootDir, extracted); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	if err := marketartifact.ExtractArchive(archivePath, install.Source.Format, extracted, installer.limits); err != nil {
		return market.CLIInstallationReceipt{}, fmt.Errorf("extract connector remote archive: %w", err)
	}
	payloadRoot, err := exactArchiveRoot(extracted, install.Extraction.Root)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	identity, err := marketartifact.InspectTree(payloadRoot)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	if identity.Algorithm != install.Extraction.InventoryAlgorithm || identity.SHA256 != install.Extraction.InventorySHA256 ||
		identity.FileCount != install.Extraction.FileCount || identity.ExpandedSizeBytes != install.Extraction.ExpandedSizeBytes {
		return market.CLIInstallationReceipt{}, errors.New("connector remote archive inventory does not match manifest")
	}
	entrypoint, err := PreparedEntrypoint(payloadRoot, install.Launch.Entrypoint)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	entryDigest, err := cliFileSHA256(entrypoint)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	entryInfo, err := os.Stat(entrypoint)
	if err != nil || entryDigest != install.Launch.SHA256 || entryInfo.Size() != install.Launch.SizeBytes {
		return market.CLIInstallationReceipt{}, errors.New("connector remote archive entrypoint does not match manifest")
	}
	payload := filepath.Join(staging, "payload")
	if err := os.Rename(payloadRoot, payload); err != nil {
		return market.CLIInstallationReceipt{}, fmt.Errorf("stage connector remote archive payload: %w", err)
	}
	if err := marketartifact.RemoveAllWithin(staging, extracted); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	entrypoint = filepath.Join(payload, filepath.FromSlash(install.Launch.Entrypoint))
	if err := makeRemoteArchiveReadOnly(payload, entrypoint); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	receipt := market.CLIInstallationReceipt{
		SchemaVersion: remoteArchiveReceiptSchema, OperationID: request.OperationID,
		ConnectorKey: request.Release.ConnectorKey, ReleaseDigest: request.Release.ReleaseDigest,
		RuntimeProfile: managed.Runtime.Profile, RuntimeABI: managed.Runtime.ABI,
		InstallKind: "remote_archive", ArchiveSHA256: install.Source.SHA256, ArchiveSize: install.Source.SizeBytes,
		ArchiveFormat: install.Source.Format, InventoryAlgorithm: identity.Algorithm, InventorySHA256: identity.SHA256,
		FileCount: identity.FileCount, ExpandedSizeBytes: identity.ExpandedSizeBytes,
		LaunchKind: "native", InstallRoot: filepath.Join(target, "payload"), Entrypoint: cli.Entrypoint,
		EntrypointSHA256: entryDigest, EntrypointSize: entryInfo.Size(),
	}
	if err := writeRemoteArchiveReceipt(staging, receipt); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	if err := installer.promote(staging, target, request.OperationID); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	return receipt, nil
}

func (installer *RemoteArchiveInstaller) ResolveCLI(ctx context.Context, release market.Release) (market.CLIInstallationReceipt, error) {
	if installer == nil || runtime.GOOS == "windows" {
		return market.CLIInstallationReceipt{}, errors.New("connector remote archive installation is unavailable on this platform")
	}
	if err := ctx.Err(); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	if _, _, _, err := remoteArchiveIntent(release); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	unlock := installer.lock(release.ConnectorKey)
	defer unlock()
	target := installer.installRoot(release)
	if _, err := os.Lstat(target); errors.Is(err, os.ErrNotExist) {
		return market.CLIInstallationReceipt{}, market.ErrReleaseInstallationAbsent
	} else if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	if err := ensureRemoteArchiveDirectory(installer.rootDir, target); err != nil {
		return market.CLIInstallationReceipt{}, fmt.Errorf("%w: %v", market.ErrReleaseInstallationInvalid, err)
	}
	receipt, err := installer.readAndVerifyReceipt(release, target)
	if err != nil {
		return market.CLIInstallationReceipt{}, fmt.Errorf("%w: %v", market.ErrReleaseInstallationInvalid, err)
	}
	return receipt, nil
}

func (installer *RemoteArchiveInstaller) RemoveCLI(ctx context.Context, request market.RemoveCLIRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if installer == nil || !safeCLIPathSegment(request.ConnectorKey) || !isSHA256Hex(request.ReleaseDigest) {
		return errors.New("connector remote archive removal identity is invalid")
	}
	unlock := installer.lock(request.ConnectorKey)
	defer unlock()
	target := filepath.Join(installer.rootDir, "releases", request.ConnectorKey, request.ReleaseDigest)
	return removeRemoteArchiveTree(installer.rootDir, target)
}

func (installer *RemoteArchiveInstaller) RemoveConnector(ctx context.Context, request market.RemoveConnectorInstallationRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if installer == nil || !safeCLIPathSegment(request.ConnectorKey) {
		return errors.New("connector remote archive removal identity is invalid")
	}
	unlock := installer.lock(request.ConnectorKey)
	defer unlock()
	target := filepath.Join(installer.rootDir, "releases", request.ConnectorKey)
	return removeRemoteArchiveTree(installer.rootDir, target)
}

func (installer *RemoteArchiveInstaller) prepareArchive(ctx context.Context, source market.RemoteArchiveSource) (string, error) {
	unlock := installer.lockNamed(installer.cacheLanes, source.SHA256)
	defer unlock()
	cacheDir := filepath.Join(installer.rootDir, "cache")
	if err := createRemoteArchiveDirectory(installer.rootDir, cacheDir); err != nil {
		return "", err
	}
	archivePath := filepath.Join(cacheDir, source.SHA256+".archive")
	if verifyRemoteArchiveFile(archivePath, source) == nil {
		return archivePath, nil
	}
	if err := removeInvalidRemoteArchiveCacheFile(installer.rootDir, archivePath); err != nil {
		return "", err
	}
	temporary := archivePath + ".partial"
	_ = os.Remove(temporary)
	runCtx, cancel := context.WithTimeout(ctx, installer.timeout)
	defer cancel()
	response, err := installer.fetch(runCtx, source)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, source.SizeBytes+1))
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil || written != source.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != source.SHA256 {
		_ = os.Remove(temporary)
		return "", errors.Join(errors.New("connector remote archive download identity is invalid"), copyErr, syncErr, closeErr)
	}
	if err := installer.rename(temporary, archivePath); err != nil {
		_ = os.Remove(temporary)
		if verifyRemoteArchiveFile(archivePath, source) == nil {
			return archivePath, nil
		}
		return "", err
	}
	if err := installer.syncDir(cacheDir); err != nil {
		return "", err
	}
	return archivePath, nil
}

func (installer *RemoteArchiveInstaller) fetch(ctx context.Context, source market.RemoteArchiveSource) (*http.Response, error) {
	current, err := url.Parse(source.URL)
	if err != nil {
		return nil, err
	}
	for redirect := 0; redirect <= maxRemoteArchiveRedirects; redirect++ {
		addresses, err := installer.validateURL(ctx, current, source.AllowedHosts)
		if err != nil {
			return nil, err
		}
		requestContext := context.WithValue(ctx, remoteArchivePinnedAddressesKey{}, remoteArchivePinnedAddresses{host: current.Hostname(), addresses: addresses})
		request, err := http.NewRequestWithContext(requestContext, http.MethodGet, current.String(), nil)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Accept-Encoding", "identity")
		response, err := installer.httpClient.Do(request)
		if err != nil {
			return nil, err
		}
		if response.StatusCode >= 300 && response.StatusCode <= 399 {
			location := response.Header.Get("Location")
			_ = response.Body.Close()
			if redirect == maxRemoteArchiveRedirects || location == "" {
				return nil, errors.New("connector remote archive redirect limit exceeded")
			}
			next, parseErr := current.Parse(location)
			if parseErr != nil {
				return nil, parseErr
			}
			current = next
			continue
		}
		if response.StatusCode != http.StatusOK || response.ContentLength != source.SizeBytes {
			_ = response.Body.Close()
			return nil, fmt.Errorf("connector remote archive response identity is invalid: status=%d contentLength=%d", response.StatusCode, response.ContentLength)
		}
		return response, nil
	}
	return nil, errors.New("connector remote archive redirect limit exceeded")
}

func (installer *RemoteArchiveInstaller) validateURL(ctx context.Context, candidate *url.URL, allowedHosts []string) ([]net.IPAddr, error) {
	if candidate == nil || candidate.Scheme != "https" || candidate.User != nil || candidate.RawQuery != "" || candidate.Fragment != "" || candidate.Port() != "" || net.ParseIP(candidate.Hostname()) != nil || !containsFold(allowedHosts, candidate.Hostname()) {
		return nil, errors.New("connector remote archive URL is not allowed")
	}
	addresses, err := installer.lookupIP(ctx, candidate.Hostname())
	if err != nil || len(addresses) == 0 {
		return nil, errors.New("resolve connector remote archive host")
	}
	for _, address := range addresses {
		ip := address.IP
		if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
			return nil, errors.New("connector remote archive host resolved to a non-public address")
		}
	}
	return addresses, nil
}

func (installer *RemoteArchiveInstaller) readAndVerifyReceipt(release market.Release, target string) (market.CLIInstallationReceipt, error) {
	managed, cli, install, err := remoteArchiveIntent(release)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	if err := ensureRemoteArchiveDirectory(installer.rootDir, target); err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	receiptPath := filepath.Join(target, remoteArchiveReceiptFile)
	receiptInfo, receiptStatErr := os.Lstat(receiptPath)
	if receiptStatErr != nil || receiptInfo.Mode()&os.ModeSymlink != 0 || !receiptInfo.Mode().IsRegular() {
		return market.CLIInstallationReceipt{}, errors.New("connector remote archive receipt is unavailable")
	}
	data, err := os.ReadFile(receiptPath)
	if err != nil || len(data) > 1<<20 {
		return market.CLIInstallationReceipt{}, errors.New("connector remote archive receipt is unavailable")
	}
	var receipt market.CLIInstallationReceipt
	if json.Unmarshal(data, &receipt) != nil || receipt.SchemaVersion != remoteArchiveReceiptSchema || receipt.InstallKind != "remote_archive" ||
		receipt.ConnectorKey != release.ConnectorKey || receipt.ReleaseDigest != release.ReleaseDigest || receipt.RuntimeProfile != managed.Runtime.Profile || receipt.RuntimeABI != managed.Runtime.ABI ||
		receipt.ArchiveSHA256 != install.Source.SHA256 || receipt.ArchiveSize != install.Source.SizeBytes || receipt.ArchiveFormat != install.Source.Format ||
		receipt.InventoryAlgorithm != install.Extraction.InventoryAlgorithm || receipt.InventorySHA256 != install.Extraction.InventorySHA256 ||
		receipt.FileCount != install.Extraction.FileCount || receipt.ExpandedSizeBytes != install.Extraction.ExpandedSizeBytes ||
		receipt.LaunchKind != install.Launch.Kind || receipt.Entrypoint != cli.Entrypoint || receipt.EntrypointSHA256 != install.Launch.SHA256 || receipt.EntrypointSize != install.Launch.SizeBytes ||
		filepath.Clean(receipt.InstallRoot) != filepath.Join(target, "payload") {
		return market.CLIInstallationReceipt{}, errors.New("connector remote archive receipt identity is invalid")
	}
	if err := ensureRemoteArchiveDirectory(installer.rootDir, receipt.InstallRoot); err != nil {
		return market.CLIInstallationReceipt{}, errors.New("connector remote archive payload path is invalid")
	}
	identity, err := marketartifact.InspectTree(receipt.InstallRoot)
	if err != nil || identity.SHA256 != receipt.InventorySHA256 || identity.FileCount != receipt.FileCount || identity.ExpandedSizeBytes != receipt.ExpandedSizeBytes {
		return market.CLIInstallationReceipt{}, errors.New("connector remote archive tree changed after activation")
	}
	entrypoint, err := PreparedEntrypoint(receipt.InstallRoot, receipt.Entrypoint)
	if err != nil {
		return market.CLIInstallationReceipt{}, err
	}
	digest, err := cliFileSHA256(entrypoint)
	info, statErr := os.Stat(entrypoint)
	if err != nil || statErr != nil || digest != receipt.EntrypointSHA256 || info.Size() != receipt.EntrypointSize {
		return market.CLIInstallationReceipt{}, errors.New("connector remote archive entrypoint changed after activation")
	}
	return receipt, nil
}

func (installer *RemoteArchiveInstaller) promote(staging, target, operationID string) error {
	if err := createRemoteArchiveDirectory(installer.rootDir, filepath.Dir(target)); err != nil {
		return err
	}
	quarantine := ""
	if _, err := os.Lstat(target); err == nil {
		quarantineRoot := filepath.Join(installer.rootDir, "quarantine")
		if err := createRemoteArchiveDirectory(installer.rootDir, quarantineRoot); err != nil {
			return err
		}
		quarantine = filepath.Join(quarantineRoot, operationID)
		if err := marketartifact.RemoveAllWithin(installer.rootDir, quarantine); err != nil {
			return fmt.Errorf("clean connector remote archive quarantine: %w", err)
		}
		if err := installer.rename(target, quarantine); err != nil {
			return fmt.Errorf("quarantine invalid connector remote archive: %w", err)
		}
	}
	if err := installer.rename(staging, target); err != nil {
		restoreErr := error(nil)
		if quarantine != "" {
			restoreErr = installer.rename(quarantine, target)
		}
		return errors.Join(fmt.Errorf("activate connector remote archive: %w", err), restoreErr)
	}
	if err := installer.syncDir(filepath.Dir(target)); err != nil {
		rollbackErr := installer.rename(target, staging)
		if rollbackErr != nil {
			rollbackErr = errors.Join(rollbackErr, removeRemoteArchiveTree(installer.rootDir, target))
		}
		if quarantine != "" {
			if _, statErr := os.Lstat(target); errors.Is(statErr, os.ErrNotExist) {
				rollbackErr = errors.Join(rollbackErr, installer.rename(quarantine, target))
			}
		}
		return errors.Join(fmt.Errorf("sync activated connector remote archive: %w", err), rollbackErr)
	}
	if quarantine != "" {
		_ = removeRemoteArchiveTree(installer.rootDir, quarantine)
	}
	return nil
}

func createRemoteArchiveDirectory(root, target string) error {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("connector remote archive directory escapes root")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	current := root
	parts := []string{}
	if relative != "." {
		parts = strings.Split(relative, string(filepath.Separator))
	}
	for _, part := range append([]string{""}, parts...) {
		if part != "" {
			current = filepath.Join(current, part)
		}
		info, statErr := os.Lstat(current)
		if errors.Is(statErr, os.ErrNotExist) {
			if mkdirErr := os.Mkdir(current, 0o700); mkdirErr != nil && !errors.Is(mkdirErr, os.ErrExist) {
				return mkdirErr
			}
			info, statErr = os.Lstat(current)
		}
		if statErr != nil {
			return statErr
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return errors.New("connector remote archive directory contains a symbolic link or non-directory")
		}
	}
	return nil
}

func ensureRemoteArchiveDirectory(root, target string) error {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("connector remote archive directory escapes root")
	}
	current := root
	parts := []string{}
	if relative != "." {
		parts = strings.Split(relative, string(filepath.Separator))
	}
	for _, part := range append([]string{""}, parts...) {
		if part != "" {
			current = filepath.Join(current, part)
		}
		info, statErr := os.Lstat(current)
		if statErr != nil {
			return statErr
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return errors.New("connector remote archive directory contains a symbolic link or non-directory")
		}
	}
	return nil
}

func removeInvalidRemoteArchiveCacheFile(root, path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || !pathWithin(root, path) {
		return errors.New("connector remote archive cache entry is unsafe")
	}
	return os.Remove(path)
}

func (installer *RemoteArchiveInstaller) installRoot(release market.Release) string {
	return filepath.Join(installer.rootDir, "releases", release.ConnectorKey, release.ReleaseDigest)
}

func (installer *RemoteArchiveInstaller) lock(connectorKey string) func() {
	return installer.lockNamed(installer.lanes, connectorKey)
}

func (installer *RemoteArchiveInstaller) lockNamed(lanes map[string]*sync.Mutex, key string) func() {
	installer.mu.Lock()
	lane := lanes[key]
	if lane == nil {
		lane = &sync.Mutex{}
		lanes[key] = lane
	}
	installer.mu.Unlock()
	lane.Lock()
	return lane.Unlock
}

func remoteArchiveIntent(release market.Release) (*market.ManagedStdioImplementation, *market.ManagedCLIInterface, *market.RemoteArchiveInstallation, error) {
	managed := release.Manifest.Implementation.ManagedStdio
	if managed == nil || managed.CLI == nil || managed.CLI.Install == nil || managed.CLI.Install.Kind != "remote_archive" || managed.CLI.Install.RemoteArchive == nil {
		return nil, nil, nil, errors.New("connector release does not declare a remote archive CLI installation")
	}
	return managed, managed.CLI, managed.CLI.Install.RemoteArchive, nil
}

func exactArchiveRoot(extracted, relative string) (string, error) {
	entries, err := os.ReadDir(extracted)
	if err != nil || len(entries) != 1 || entries[0].Name() != relative {
		return "", errors.New("connector remote archive must contain exactly its declared root")
	}
	root := filepath.Join(extracted, filepath.FromSlash(relative))
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("connector remote archive root is invalid")
	}
	return root, nil
}

func makeRemoteArchiveReadOnly(root, entrypoint string) error {
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return os.Chmod(path, 0o500)
		}
		mode := os.FileMode(0o400)
		if path == entrypoint {
			mode = 0o500
		}
		return os.Chmod(path, mode)
	})
}

func makeRemoteArchiveWritable(root string) error {
	if _, err := os.Lstat(root); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("connector remote archive cleanup encountered a symbolic link")
		}
		if entry.IsDir() {
			return os.Chmod(path, 0o700)
		}
		return os.Chmod(path, 0o600)
	})
}

func removeRemoteArchiveTree(root, target string) error {
	if err := ensureRemoteArchiveDirectory(root, target); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return marketartifact.RemoveAllWithin(root, target)
		}
		return err
	}
	if err := makeRemoteArchiveWritable(target); err != nil {
		return err
	}
	return marketartifact.RemoveAllWithin(root, target)
}

func writeRemoteArchiveReceipt(root string, receipt market.CLIInstallationReceipt) error {
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(root, remoteArchiveReceiptFile), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return marketartifact.SyncDirectory(root)
}

func verifyRemoteArchiveFile(path string, source market.RemoteArchiveSource) error {
	pathInfo, err := os.Lstat(path)
	if err != nil || pathInfo.Mode()&os.ModeSymlink != 0 || !pathInfo.Mode().IsRegular() {
		return errors.New("connector remote archive cache identity is invalid")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	afterInfo, afterErr := os.Lstat(path)
	if err != nil || afterErr != nil || afterInfo.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || !afterInfo.Mode().IsRegular() || !os.SameFile(pathInfo, info) || !os.SameFile(info, afterInfo) || info.Size() != source.SizeBytes {
		return errors.New("connector remote archive cache identity is invalid")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != source.SHA256 {
		return errors.New("connector remote archive cache digest is invalid")
	}
	return nil
}

func containsFold(values []string, expected string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), expected) {
			return true
		}
	}
	return false
}
