package artifact

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path"
	"path/filepath"
	"strings"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

const packagedManifestPath = "connector-manifest.json"
const receiptFilename = ".tutti-connector-receipt.json"

type Fetcher interface {
	Fetch(ctx context.Context, request FetchRequest) (FetchResponse, error)
}

type FetchRequest struct {
	OperationID string
	Scope       market.OperationScope
	Generation  market.HostGeneration
	Release     market.Release
}

type FetchResponse struct {
	Body          io.ReadCloser
	ContentLength int64
	MediaType     string
}

type Limits struct {
	MaxDownloadBytes    int64
	MaxFiles            int
	MaxFileBytes        int64
	MaxExpandedBytes    int64
	MaxCompressionRatio int64
}

func DefaultLimits() Limits {
	return Limits{
		MaxDownloadBytes:    256 << 20,
		MaxFiles:            10_000,
		MaxFileBytes:        64 << 20,
		MaxExpandedBytes:    512 << 20,
		MaxCompressionRatio: 200,
	}
}

type Config struct {
	RootDir string
	Fetcher Fetcher
	Limits  Limits
}

type ImporterConfig struct {
	RootDir string
	Limits  Limits
}

type ImportArchiveRequest struct {
	OperationID string
	Scope       market.OperationScope
	Generation  market.HostGeneration
	Release     market.Release
	ArchivePath string
}

// Importer installs an already-synchronized archive. It has no Fetcher and
// therefore cannot perform network I/O; remote runtime owners use it after
// their host data plane has transferred the verified candidate.
type Importer struct {
	mechanics *Preparer
}

type Preparer struct {
	rootDir string
	cache   *DownloadCache
	limits  Limits
}

var _ market.ArtifactPreparer = (*Preparer)(nil)

func NewImporter(config ImporterConfig) (*Importer, error) {
	root, limits, err := validateArtifactRoot(config.RootDir, config.Limits)
	if err != nil {
		return nil, err
	}
	return &Importer{mechanics: &Preparer{rootDir: root, limits: limits}}, nil
}

func (importer *Importer) Import(
	ctx context.Context,
	request ImportArchiveRequest,
) (market.PreparedArtifactReceipt, error) {
	prepareRequest := market.PrepareArtifactRequest{OperationID: request.OperationID, Scope: request.Scope,
		Generation: request.Generation, Release: request.Release}
	if err := validatePrepareRequest(prepareRequest); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	if !filepath.IsAbs(request.ArchivePath) {
		return market.PreparedArtifactReceipt{}, errors.New("connector synchronized archive path must be absolute")
	}
	if err := verifyArtifactFile(request.ArchivePath, request.Release.Artifact); err != nil {
		return market.PreparedArtifactReceipt{}, fmt.Errorf("verify synchronized connector artifact: %w", err)
	}
	return importer.mechanics.importArchive(ctx, prepareRequest, request.ArchivePath)
}

func (importer *Importer) ResolvePrepared(
	ctx context.Context,
	release market.Release,
) (market.PreparedArtifactReceipt, error) {
	if err := ctx.Err(); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	if err := market.ValidateRuntimeReleaseShape(release); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	target, err := importer.mechanics.preparedPath(release)
	if err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	if receipt, ok := readExistingReceipt(target, market.PrepareArtifactRequest{Release: release}); ok {
		return receipt, nil
	}
	if _, statErr := os.Stat(target); errors.Is(statErr, os.ErrNotExist) {
		return market.PreparedArtifactReceipt{}, market.ErrReleaseInstallationAbsent
	} else if statErr != nil {
		return market.PreparedArtifactReceipt{}, fmt.Errorf("inspect prepared connector artifact: %w", statErr)
	}
	return market.PreparedArtifactReceipt{}, market.ErrReleaseInstallationInvalid
}

func (importer *Importer) Remove(ctx context.Context, request market.RemoveArtifactRequest) error {
	return importer.mechanics.removePrepared(ctx, request)
}

func (importer *Importer) RemoveConnector(ctx context.Context, request market.RemoveConnectorInstallationRequest) error {
	return importer.mechanics.removePreparedConnector(ctx, request.ConnectorKey)
}

// ResolvePrepared revalidates the installed receipt, packaged
// manifest, and full inventory before a durable connector runtime is restored.
// An invalid prepared tree is rebuilt from the verified artifact blob; a
// receipt is never treated as an authenticity root by itself.
func (preparer *Preparer) ResolvePrepared(ctx context.Context, release market.Release) (market.PreparedArtifactReceipt, error) {
	if err := ctx.Err(); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	if err := market.ValidateRuntimeReleaseShape(release); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	target, err := preparer.preparedPath(release)
	if err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	receipt, ok := readExistingReceipt(target, market.PrepareArtifactRequest{Release: release})
	if ok {
		return receipt, nil
	}
	if _, statErr := os.Stat(target); errors.Is(statErr, os.ErrNotExist) {
		return market.PreparedArtifactReceipt{}, market.ErrReleaseInstallationAbsent
	} else if statErr != nil {
		return market.PreparedArtifactReceipt{}, fmt.Errorf("inspect prepared connector artifact: %w", statErr)
	}
	return market.PreparedArtifactReceipt{}, market.ErrReleaseInstallationInvalid
}

func NewPreparer(config Config) (*Preparer, error) {
	if config.Fetcher == nil {
		return nil, errors.New("connector artifact fetcher is required")
	}
	root, limits, err := validateArtifactRoot(config.RootDir, config.Limits)
	if err != nil {
		return nil, err
	}
	cache, err := NewDownloadCache(DownloadCacheConfig{RootDir: filepath.Join(root, "cache"),
		Fetcher: config.Fetcher, MaxDownloadBytes: limits.MaxDownloadBytes})
	if err != nil {
		return nil, err
	}
	return &Preparer{rootDir: root, cache: cache, limits: limits}, nil
}

func (preparer *Preparer) Prepare(
	ctx context.Context,
	request market.PrepareArtifactRequest,
) (market.PreparedArtifactReceipt, error) {
	if err := validatePrepareRequest(request); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	cached, err := preparer.cache.PrepareCandidate(ctx, request)
	if err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	receipt, err := preparer.importArchive(ctx, request, cached.Path)
	if err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	if _, err := preparer.cache.PromoteCandidate(ctx, cached, request.Release); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	return receipt, nil
}

func (preparer *Preparer) importArchive(
	ctx context.Context,
	request market.PrepareArtifactRequest,
	archivePath string,
) (market.PreparedArtifactReceipt, error) {
	if err := ctx.Err(); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	target, err := preparer.preparedPath(request.Release)
	if err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	staging := filepath.Join(preparer.rootDir, "staging", request.OperationID)
	if err := ensureWithin(preparer.rootDir, staging); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	if err := os.RemoveAll(staging); err != nil {
		return market.PreparedArtifactReceipt{}, fmt.Errorf("reset connector artifact staging directory: %w", err)
	}
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return market.PreparedArtifactReceipt{}, fmt.Errorf("create connector artifact staging directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(staging) }()
	extracted := filepath.Join(staging, "extracted")
	if err := os.MkdirAll(extracted, 0o700); err != nil {
		return market.PreparedArtifactReceipt{}, fmt.Errorf("create connector artifact extraction directory: %w", err)
	}
	if err := preparer.extract(archivePath, request.Release.Artifact.MediaType, extracted); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	if err := verifyPackagedManifest(extracted, request.Release.ManifestDigest); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	inventoryDigest, err := inventoryDigest(extracted)
	if err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	// A local receipt is not an authenticity root. Reuse is allowed only after
	// extracting the digest-verified artifact blob for this attempt and proving
	// that the prepared tree has the same inventory as those freshly verified bytes.
	if existing, ok := readExistingReceipt(target, request); ok && existing.InventoryDigest == inventoryDigest {
		existing.OperationID = request.OperationID
		return existing, nil
	}

	receipt := market.PreparedArtifactReceipt{
		OperationID:     request.OperationID,
		ConnectorKey:    request.Release.ConnectorKey,
		Version:         request.Release.Version,
		ReleaseDigest:   request.Release.ReleaseDigest,
		ArtifactSHA256:  request.Release.Artifact.SHA256,
		InventoryDigest: inventoryDigest,
		PreparedPath:    target,
	}
	if err := writeReceipt(extracted, receipt); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return market.PreparedArtifactReceipt{}, fmt.Errorf("create connector prepared parent directory: %w", err)
	}
	if err := os.RemoveAll(target); err != nil {
		return market.PreparedArtifactReceipt{}, fmt.Errorf("replace invalid connector prepared artifact: %w", err)
	}
	if err := os.Rename(extracted, target); err != nil {
		if existing, ok := readExistingReceipt(target, request); ok && existing.InventoryDigest == inventoryDigest {
			existing.OperationID = request.OperationID
			return existing, nil
		}
		return market.PreparedArtifactReceipt{}, fmt.Errorf("promote connector prepared artifact: %w", err)
	}
	if err := syncDirectory(filepath.Dir(target)); err != nil {
		return market.PreparedArtifactReceipt{}, err
	}
	return receipt, nil
}

func (preparer *Preparer) Remove(ctx context.Context, request market.RemoveArtifactRequest) error {
	if err := preparer.removePrepared(ctx, request); err != nil {
		return err
	}
	return preparer.cache.RemoveConnector(ctx, request.ConnectorKey)
}

func (preparer *Preparer) RemoveConnector(ctx context.Context, request market.RemoveConnectorInstallationRequest) error {
	if err := preparer.removePreparedConnector(ctx, request.ConnectorKey); err != nil {
		return err
	}
	return preparer.cache.RemoveConnector(ctx, request.ConnectorKey)
}

func (preparer *Preparer) removePreparedConnector(ctx context.Context, connectorKey string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !safeSegment(connectorKey) {
		return errors.New("connector artifact removal identity is invalid")
	}
	target := filepath.Join(preparer.rootDir, "prepared", connectorKey)
	if err := ensureWithin(preparer.rootDir, target); err != nil {
		return err
	}
	if err := removeAllWithin(preparer.rootDir, target); err != nil {
		return fmt.Errorf("remove Connector prepared artifacts: %w", err)
	}
	return nil
}

func (preparer *Preparer) removePrepared(ctx context.Context, request market.RemoveArtifactRequest) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if !safeSegment(request.ConnectorKey) || !safeSegment(request.Version) || !isSHA256(request.ReleaseDigest) {
		return errors.New("connector artifact removal identity is invalid")
	}
	target := filepath.Join(preparer.rootDir, "prepared", request.ConnectorKey, request.Version, request.ReleaseDigest)
	if err := ensureWithin(preparer.rootDir, target); err != nil {
		return err
	}
	if err := removeAllWithin(preparer.rootDir, target); err != nil {
		return fmt.Errorf("remove connector prepared artifact: %w", err)
	}
	return nil
}

func (preparer *Preparer) extract(archivePath, mediaType, destination string) error {
	mediaType, _, _ = mime.ParseMediaType(mediaType)
	switch strings.ToLower(mediaType) {
	case "application/zip", "application/vnd.tutti.connector+zip":
		return preparer.extractZIP(archivePath, destination)
	case "application/gzip", "application/x-gzip", "application/vnd.tutti.connector+tar+gzip":
		return preparer.extractTarGzip(archivePath, destination)
	default:
		return fmt.Errorf("unsupported connector artifact media type %q", mediaType)
	}
}

func (preparer *Preparer) extractZIP(archivePath, destination string) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("open connector zip artifact: %w", err)
	}
	defer reader.Close()
	if len(reader.File) > preparer.limits.MaxFiles {
		return fmt.Errorf("connector artifact contains more than %d entries", preparer.limits.MaxFiles)
	}
	var expanded int64
	seenEntries := make(map[string]struct{}, len(reader.File))
	for _, entry := range reader.File {
		if entry.Mode()&os.ModeSymlink != 0 || (!entry.FileInfo().IsDir() && !entry.Mode().IsRegular()) {
			return fmt.Errorf("connector artifact entry %q is not a regular file or directory", entry.Name)
		}
		entryKey, err := safeArchiveEntryKey(entry.Name)
		if err != nil {
			return err
		}
		if _, duplicate := seenEntries[entryKey]; duplicate {
			return fmt.Errorf("connector artifact contains duplicate or case-colliding entry %q", entry.Name)
		}
		seenEntries[entryKey] = struct{}{}
		target, err := safeArchiveTarget(destination, entry.Name)
		if err != nil {
			return err
		}
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			continue
		}
		declared := int64(entry.UncompressedSize64)
		if err := preparer.checkExpandedSize(declared, &expanded, int64(entry.CompressedSize64)); err != nil {
			return fmt.Errorf("connector artifact entry %q: %w", entry.Name, err)
		}
		body, err := entry.Open()
		if err != nil {
			return err
		}
		if err := writeArchiveFile(target, body, declared); err != nil {
			body.Close()
			return err
		}
		if err := body.Close(); err != nil {
			return err
		}
	}
	return nil
}

func (preparer *Preparer) extractTarGzip(archivePath, destination string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return fmt.Errorf("open connector gzip artifact: %w", err)
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	var expanded int64
	entries := 0
	seenEntries := make(map[string]struct{})
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read connector tar artifact: %w", err)
		}
		entries++
		if entries > preparer.limits.MaxFiles {
			return fmt.Errorf("connector artifact contains more than %d entries", preparer.limits.MaxFiles)
		}
		entryKey, err := safeArchiveEntryKey(header.Name)
		if err != nil {
			return err
		}
		if _, duplicate := seenEntries[entryKey]; duplicate {
			return fmt.Errorf("connector artifact contains duplicate or case-colliding entry %q", header.Name)
		}
		seenEntries[entryKey] = struct{}{}
		target, err := safeArchiveTarget(destination, header.Name)
		if err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
		case tar.TypeReg, byte(0):
			if err := preparer.checkExpandedSize(header.Size, &expanded, 0); err != nil {
				return fmt.Errorf("connector artifact entry %q: %w", header.Name, err)
			}
			if err := writeArchiveFile(target, reader, header.Size); err != nil {
				return err
			}
		default:
			return fmt.Errorf("connector artifact entry %q has unsupported link or device type", header.Name)
		}
	}
	compressed, err := file.Stat()
	if err != nil {
		return err
	}
	if compressed.Size() <= 0 || (expanded > 0 && expanded/compressed.Size() > preparer.limits.MaxCompressionRatio) {
		return fmt.Errorf("connector artifact compression ratio exceeds limit of %d", preparer.limits.MaxCompressionRatio)
	}
	return nil
}

func (preparer *Preparer) checkExpandedSize(size int64, total *int64, compressed int64) error {
	if size < 0 || size > preparer.limits.MaxFileBytes {
		return fmt.Errorf("expanded file size %d exceeds limit", size)
	}
	if compressed > 0 && size > 0 && size/compressed > preparer.limits.MaxCompressionRatio {
		return fmt.Errorf("compression ratio exceeds limit of %d", preparer.limits.MaxCompressionRatio)
	}
	*total += size
	if *total > preparer.limits.MaxExpandedBytes {
		return fmt.Errorf("expanded artifact size exceeds limit of %d bytes", preparer.limits.MaxExpandedBytes)
	}
	return nil
}

func (preparer *Preparer) preparedPath(release market.Release) (string, error) {
	if !safeSegment(release.ConnectorKey) || !safeSegment(release.Version) || !isSHA256(release.ReleaseDigest) {
		return "", errors.New("connector release identity is not safe for an artifact path")
	}
	target := filepath.Join(preparer.rootDir, "prepared", release.ConnectorKey, release.Version, release.ReleaseDigest)
	if err := ensureWithin(preparer.rootDir, target); err != nil {
		return "", err
	}
	return target, nil
}

func validatePrepareRequest(request market.PrepareArtifactRequest) error {
	if strings.TrimSpace(request.OperationID) == "" || !safeSegment(request.OperationID) {
		return errors.New("connector artifact operation id is invalid")
	}
	return market.ValidateReleaseShape(request.Release)
}

func validateLimits(limits Limits) error {
	if limits.MaxDownloadBytes <= 0 || limits.MaxFiles <= 0 || limits.MaxFileBytes <= 0 ||
		limits.MaxExpandedBytes <= 0 || limits.MaxCompressionRatio <= 0 {
		return errors.New("connector artifact limits must all be positive")
	}
	return nil
}

func validateArtifactRoot(rootDir string, limits Limits) (string, Limits, error) {
	if strings.TrimSpace(rootDir) == "" {
		return "", Limits{}, errors.New("connector artifact root directory is required")
	}
	if !filepath.IsAbs(rootDir) {
		return "", Limits{}, errors.New("connector artifact root directory must be absolute")
	}
	if limits == (Limits{}) {
		limits = DefaultLimits()
	}
	if err := validateLimits(limits); err != nil {
		return "", Limits{}, err
	}
	return filepath.Clean(rootDir), limits, nil
}

func safeArchiveTarget(root, name string) (string, error) {
	if _, err := safeArchiveEntryKey(name); err != nil {
		return "", err
	}
	clean := filepath.Clean(filepath.FromSlash(strings.TrimSuffix(name, "/")))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("connector artifact entry %q escapes the extraction root", name)
	}
	target := filepath.Join(root, clean)
	if err := ensureWithin(root, target); err != nil {
		return "", fmt.Errorf("connector artifact entry %q escapes the extraction root", name)
	}
	return target, nil
}

func safeArchiveEntryKey(name string) (string, error) {
	canonical := strings.TrimSuffix(name, "/")
	if canonical == "" || strings.HasPrefix(canonical, "/") || strings.ContainsAny(canonical, "\\:\x00") ||
		path.Clean(canonical) != canonical {
		return "", fmt.Errorf("connector artifact entry %q has an unsafe portable path", name)
	}
	for _, segment := range strings.Split(canonical, "/") {
		trimmed := strings.TrimRight(segment, ". ")
		base := strings.ToLower(strings.SplitN(trimmed, ".", 2)[0])
		reserved := base == "con" || base == "prn" || base == "aux" || base == "nul" ||
			(len(base) == 4 && (strings.HasPrefix(base, "com") || strings.HasPrefix(base, "lpt")) && base[3] >= '1' && base[3] <= '9')
		if segment == "" || trimmed != segment || reserved {
			return "", fmt.Errorf("connector artifact entry %q is not portable to Windows", name)
		}
	}
	return strings.ToLower(canonical), nil
}

func ensureWithin(root, target string) error {
	relative, err := filepath.Rel(filepath.Clean(root), filepath.Clean(target))
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("connector artifact path escapes configured root")
	}
	return nil
}

func removeAllWithin(root, target string) error {
	root = filepath.Clean(root)
	target = filepath.Clean(target)
	if err := ensureWithin(root, target); err != nil {
		return err
	}
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == "." {
		return errors.New("connector artifact removal target is invalid")
	}
	current := root
	parts := strings.Split(relative, string(filepath.Separator))
	for index, part := range append([]string{""}, parts...) {
		if index > 0 {
			current = filepath.Join(current, part)
		}
		info, statErr := os.Lstat(current)
		if errors.Is(statErr, os.ErrNotExist) {
			return nil
		}
		if statErr != nil {
			return statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return errors.New("connector artifact removal path contains a symbolic link")
		}
		if index < len(parts) && !info.IsDir() {
			return errors.New("connector artifact removal parent is not a directory")
		}
	}
	return os.RemoveAll(target)
}

func writeArchiveFile(target string, body io.Reader, declared int64) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	written, copyErr := io.Copy(file, io.LimitReader(body, declared+1))
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if syncErr != nil {
		return syncErr
	}
	if written != declared {
		return fmt.Errorf("connector artifact entry wrote %d bytes, expected %d", written, declared)
	}
	return nil
}

func verifyPackagedManifest(root, expectedDigest string) error {
	path := filepath.Join(root, packagedManifestPath)
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read packaged connector manifest: %w", err)
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != expectedDigest {
		return errors.New("packaged connector manifest digest does not match release")
	}
	return nil
}

func verifyArtifactFile(path string, artifact market.Artifact) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != artifact.SizeBytes {
		return errors.New("connector artifact blob size is invalid")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
		return errors.New("connector artifact blob digest is invalid")
	}
	return nil
}

func writeReceipt(root string, receipt market.PreparedArtifactReceipt) error {
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	path := filepath.Join(root, receiptFilename)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create connector artifact receipt: %w", err)
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return fmt.Errorf("write connector artifact receipt: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return fmt.Errorf("sync connector artifact receipt: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("write connector artifact receipt: %w", err)
	}
	return syncDirectory(root)
}

func readExistingReceipt(
	target string,
	request market.PrepareArtifactRequest,
) (market.PreparedArtifactReceipt, bool) {
	data, err := os.ReadFile(filepath.Join(target, receiptFilename))
	if err != nil {
		return market.PreparedArtifactReceipt{}, false
	}
	var receipt market.PreparedArtifactReceipt
	if json.Unmarshal(data, &receipt) != nil {
		return market.PreparedArtifactReceipt{}, false
	}
	valid := receipt.ConnectorKey == request.Release.ConnectorKey &&
		receipt.Version == request.Release.Version &&
		receipt.ReleaseDigest == request.Release.ReleaseDigest &&
		receipt.ArtifactSHA256 == request.Release.Artifact.SHA256 &&
		receipt.PreparedPath == target && receipt.InventoryDigest != ""
	if !valid {
		return market.PreparedArtifactReceipt{}, false
	}
	actualInventory, err := inventoryDigest(target)
	if err != nil || actualInventory != receipt.InventoryDigest ||
		verifyPackagedManifest(target, request.Release.ManifestDigest) != nil {
		return market.PreparedArtifactReceipt{}, false
	}
	// The prepared artifact is content-addressed and may be reused by a retry
	// with a new operation id. Return a receipt fenced to the current attempt.
	receipt.OperationID = request.OperationID
	return receipt, true
}

func inventoryDigest(root string) (string, error) {
	hash := sha256.New()
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == "." || relative == receiptFilename {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("prepared connector inventory contains an unsupported file type")
		}
		_, _ = io.WriteString(hash, filepath.ToSlash(relative))
		_, _ = hash.Write([]byte{0})
		if entry.IsDir() {
			_, _ = hash.Write([]byte("dir\x00"))
			return nil
		}
		_, _ = io.WriteString(hash, fmt.Sprintf("file\x00%d\x00", info.Size()))
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(hash, file)
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
	if err != nil {
		return "", fmt.Errorf("verify prepared connector inventory: %w", err)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync connector artifact directory: %w", err)
	}
	return nil
}

func sameMediaType(actual, expected string) bool {
	actualType, _, actualErr := mime.ParseMediaType(actual)
	expectedType, _, expectedErr := mime.ParseMediaType(expected)
	return actualErr == nil && expectedErr == nil && strings.EqualFold(actualType, expectedType)
}

func safeSegment(value string) bool {
	return value != "" && value != "." && value != ".." &&
		!strings.ContainsAny(value, `/\\`) && !strings.ContainsRune(value, '\x00')
}

func isSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && strings.ToLower(value) == value
}

func minPositive(left, right int64) int64 {
	if left < right {
		return left
	}
	return right
}
