package artifact

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

const (
	downloadCacheReceiptSchema = "tutti.connector.download-cache.v1"
	downloadCacheArtifactFile  = "artifact"
	downloadCacheReceiptFile   = "receipt.json"
)

type DownloadCacheConfig struct {
	RootDir          string
	Fetcher          Fetcher
	MaxDownloadBytes int64
}

// CachedArtifact is a verified raw release archive. Slot is either current or
// candidate. Callers must not persist Path outside the owning machine.
type CachedArtifact struct {
	SchemaVersion string `json:"schemaVersion"`
	OperationID   string `json:"operationId"`
	ConnectorKey  string `json:"connectorKey"`
	ReleaseID     string `json:"releaseId"`
	ReleaseDigest string `json:"releaseDigest"`
	ArtifactSHA   string `json:"artifactSha256"`
	SizeBytes     int64  `json:"sizeBytes"`
	MediaType     string `json:"mediaType"`
	ObjectVersion string `json:"objectVersion,omitempty"`
	Slot          string `json:"slot"`
	Path          string `json:"path"`
}

// DownloadCache retains only the last successfully installed raw archive plus
// one replaceable candidate per Connector. It intentionally does not provide a
// historical content-addressed blob store.
type DownloadCache struct {
	rootDir          string
	fetcher          Fetcher
	maxDownloadBytes int64
	mu               sync.Mutex
	connectorLanes   map[string]*sync.Mutex
	downloadSlots    chan struct{}
}

func NewDownloadCache(config DownloadCacheConfig) (*DownloadCache, error) {
	if !filepath.IsAbs(strings.TrimSpace(config.RootDir)) {
		return nil, errors.New("connector download cache root must be absolute")
	}
	if config.Fetcher == nil {
		return nil, errors.New("connector download cache fetcher is required")
	}
	limit := config.MaxDownloadBytes
	if limit <= 0 {
		limit = DefaultLimits().MaxDownloadBytes
	}
	return &DownloadCache{rootDir: filepath.Clean(config.RootDir), fetcher: config.Fetcher, maxDownloadBytes: limit,
		connectorLanes: make(map[string]*sync.Mutex), downloadSlots: make(chan struct{}, 4)}, nil
}

func (cache *DownloadCache) PrepareCandidate(
	ctx context.Context,
	request market.PrepareArtifactRequest,
) (CachedArtifact, error) {
	return cache.prepareCandidate(ctx, request, market.ValidateReleaseShape)
}

func (cache *DownloadCache) prepareCandidate(
	ctx context.Context,
	request market.PrepareArtifactRequest,
	validate func(market.Release) error,
) (CachedArtifact, error) {
	if cache == nil {
		return CachedArtifact{}, errors.New("connector download cache is unavailable")
	}
	if !safeSegment(request.OperationID) {
		return CachedArtifact{}, errors.New("connector artifact operation id is invalid")
	}
	if err := validate(request.Release); err != nil {
		return CachedArtifact{}, err
	}
	releaseLane := cache.lockConnector(request.Release.ConnectorKey)
	defer releaseLane()
	select {
	case cache.downloadSlots <- struct{}{}:
		defer func() { <-cache.downloadSlots }()
	case <-ctx.Done():
		return CachedArtifact{}, ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return CachedArtifact{}, err
	}
	root, err := cache.connectorRoot(request.Release.ConnectorKey)
	if err != nil {
		return CachedArtifact{}, err
	}
	if err := cache.recoverPromotion(root); err != nil {
		return CachedArtifact{}, err
	}
	if current, ok := cache.readSlot(root, "current", request.OperationID, request.Release); ok {
		return current, nil
	}
	if candidate, ok := cache.readSlot(root, "candidate", request.OperationID, request.Release); ok {
		return candidate, nil
	}
	return cache.downloadCandidate(ctx, root, request)
}

func (cache *DownloadCache) PromoteCandidate(
	ctx context.Context,
	candidate CachedArtifact,
	release market.Release,
) (CachedArtifact, error) {
	if cache == nil {
		return CachedArtifact{}, errors.New("connector download cache is unavailable")
	}
	releaseLane := cache.lockConnector(release.ConnectorKey)
	defer releaseLane()
	if err := ctx.Err(); err != nil {
		return CachedArtifact{}, err
	}
	root, err := cache.connectorRoot(release.ConnectorKey)
	if err != nil {
		return CachedArtifact{}, err
	}
	if err := cache.recoverPromotion(root); err != nil {
		return CachedArtifact{}, err
	}
	if current, ok := cache.readSlot(root, "current", candidate.OperationID, release); ok {
		_ = os.RemoveAll(filepath.Join(root, "candidate"))
		return current, nil
	}
	verified, ok := cache.readSlot(root, "candidate", candidate.OperationID, release)
	if !ok || candidate.ReleaseDigest != verified.ReleaseDigest || candidate.ArtifactSHA != verified.ArtifactSHA {
		return CachedArtifact{}, errors.New("connector artifact candidate is missing or mismatched")
	}
	currentPath := filepath.Join(root, "current")
	candidatePath := filepath.Join(root, "candidate")
	retiredPath := filepath.Join(root, ".retired")
	if err := os.RemoveAll(retiredPath); err != nil {
		return CachedArtifact{}, fmt.Errorf("reset retired connector artifact: %w", err)
	}
	if _, err := os.Stat(currentPath); err == nil {
		if err := os.Rename(currentPath, retiredPath); err != nil {
			return CachedArtifact{}, fmt.Errorf("retire current connector artifact: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return CachedArtifact{}, err
	}
	if err := os.Rename(candidatePath, currentPath); err != nil {
		_ = os.Rename(retiredPath, currentPath)
		return CachedArtifact{}, fmt.Errorf("promote connector artifact candidate: %w", err)
	}
	if err := syncDirectory(root); err != nil {
		return CachedArtifact{}, err
	}
	if err := os.RemoveAll(retiredPath); err != nil {
		return CachedArtifact{}, fmt.Errorf("remove retired connector artifact: %w", err)
	}
	current, ok := cache.readSlot(root, "current", candidate.OperationID, release)
	if !ok {
		return CachedArtifact{}, errors.New("promoted connector artifact could not be verified")
	}
	return current, nil
}

func (cache *DownloadCache) RemoveConnector(ctx context.Context, connectorKey string) error {
	if cache == nil {
		return errors.New("connector download cache is unavailable")
	}
	releaseLane := cache.lockConnector(connectorKey)
	defer releaseLane()
	if err := ctx.Err(); err != nil {
		return err
	}
	root, err := cache.connectorRoot(connectorKey)
	if err != nil {
		return err
	}
	return removeAllWithin(cache.rootDir, root)
}

func (cache *DownloadCache) lockConnector(connectorKey string) func() {
	cache.mu.Lock()
	lane := cache.connectorLanes[connectorKey]
	if lane == nil {
		lane = &sync.Mutex{}
		cache.connectorLanes[connectorKey] = lane
	}
	cache.mu.Unlock()
	lane.Lock()
	return lane.Unlock
}

func (cache *DownloadCache) downloadCandidate(
	ctx context.Context,
	root string,
	request market.PrepareArtifactRequest,
) (CachedArtifact, error) {
	release := request.Release
	staging := filepath.Join(root, ".candidate-staging")
	if err := os.RemoveAll(staging); err != nil {
		return CachedArtifact{}, fmt.Errorf("reset connector artifact candidate staging: %w", err)
	}
	if err := os.MkdirAll(staging, 0o700); err != nil {
		return CachedArtifact{}, fmt.Errorf("create connector artifact candidate staging: %w", err)
	}
	defer os.RemoveAll(staging)
	response, err := cache.fetcher.Fetch(ctx, FetchRequest{
		OperationID: request.OperationID,
		Scope:       request.Scope,
		Generation:  request.Generation,
		Release:     release,
	})
	if err != nil {
		return CachedArtifact{}, fmt.Errorf("fetch connector artifact: %w", err)
	}
	if response.Body == nil {
		return CachedArtifact{}, errors.New("fetch connector artifact: response body is nil")
	}
	defer response.Body.Close()
	if response.ContentLength > 0 && response.ContentLength != release.Artifact.SizeBytes {
		return CachedArtifact{}, fmt.Errorf("connector artifact content length %d does not match declared size %d", response.ContentLength, release.Artifact.SizeBytes)
	}
	if !sameMediaType(response.MediaType, release.Artifact.MediaType) {
		return CachedArtifact{}, fmt.Errorf("connector artifact media type %q does not match declared media type %q", response.MediaType, release.Artifact.MediaType)
	}
	limit := minPositive(cache.maxDownloadBytes, release.Artifact.SizeBytes)
	artifactPath := filepath.Join(staging, downloadCacheArtifactFile)
	file, err := os.OpenFile(artifactPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return CachedArtifact{}, fmt.Errorf("create connector artifact candidate: %w", err)
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, limit+1))
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil {
		return CachedArtifact{}, fmt.Errorf("download connector artifact: %w", copyErr)
	}
	if syncErr != nil {
		return CachedArtifact{}, fmt.Errorf("sync connector artifact candidate: %w", syncErr)
	}
	if closeErr != nil {
		return CachedArtifact{}, fmt.Errorf("close connector artifact candidate: %w", closeErr)
	}
	if written != release.Artifact.SizeBytes || written > limit {
		return CachedArtifact{}, fmt.Errorf("connector artifact size %d does not match declared size %d", written, release.Artifact.SizeBytes)
	}
	if actual := hex.EncodeToString(hash.Sum(nil)); actual != release.Artifact.SHA256 {
		return CachedArtifact{}, errors.New("connector artifact SHA-256 does not match release")
	}
	receipt := CachedArtifact{SchemaVersion: downloadCacheReceiptSchema, OperationID: request.OperationID,
		ConnectorKey: release.ConnectorKey, ReleaseID: release.ReleaseID, ReleaseDigest: release.ReleaseDigest,
		ArtifactSHA: release.Artifact.SHA256, SizeBytes: release.Artifact.SizeBytes,
		MediaType: release.Artifact.MediaType, ObjectVersion: release.Artifact.ObjectVersion, Slot: "candidate"}
	if err := writeDownloadCacheReceipt(staging, receipt); err != nil {
		return CachedArtifact{}, err
	}
	candidatePath := filepath.Join(root, "candidate")
	if err := os.RemoveAll(candidatePath); err != nil {
		return CachedArtifact{}, fmt.Errorf("replace connector artifact candidate: %w", err)
	}
	if err := os.Rename(staging, candidatePath); err != nil {
		return CachedArtifact{}, fmt.Errorf("publish connector artifact candidate: %w", err)
	}
	if err := syncDirectory(root); err != nil {
		return CachedArtifact{}, err
	}
	result, ok := cache.readSlot(root, "candidate", request.OperationID, release)
	if !ok {
		return CachedArtifact{}, errors.New("downloaded connector artifact candidate could not be verified")
	}
	return result, nil
}

func (*DownloadCache) readSlot(
	root string,
	slot string,
	operationID string,
	release market.Release,
) (CachedArtifact, bool) {
	directory := filepath.Join(root, slot)
	data, err := os.ReadFile(filepath.Join(directory, downloadCacheReceiptFile))
	if err != nil {
		return CachedArtifact{}, false
	}
	var receipt CachedArtifact
	if json.Unmarshal(data, &receipt) != nil || receipt.SchemaVersion != downloadCacheReceiptSchema ||
		receipt.ConnectorKey != release.ConnectorKey || receipt.ReleaseID != release.ReleaseID ||
		receipt.ReleaseDigest != release.ReleaseDigest || receipt.ArtifactSHA != release.Artifact.SHA256 ||
		receipt.SizeBytes != release.Artifact.SizeBytes || receipt.MediaType != release.Artifact.MediaType ||
		receipt.ObjectVersion != release.Artifact.ObjectVersion {
		return CachedArtifact{}, false
	}
	artifactPath := filepath.Join(directory, downloadCacheArtifactFile)
	if verifyArtifactFile(artifactPath, release.Artifact) != nil {
		return CachedArtifact{}, false
	}
	receipt.OperationID = operationID
	receipt.Slot = slot
	receipt.Path = artifactPath
	return receipt, true
}

func (*DownloadCache) recoverPromotion(root string) error {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	current := filepath.Join(root, "current")
	retired := filepath.Join(root, ".retired")
	_, currentErr := os.Stat(current)
	_, retiredErr := os.Stat(retired)
	switch {
	case errors.Is(currentErr, os.ErrNotExist) && retiredErr == nil:
		if err := os.Rename(retired, current); err != nil {
			return fmt.Errorf("recover current connector artifact: %w", err)
		}
	case currentErr == nil && retiredErr == nil:
		if err := os.RemoveAll(retired); err != nil {
			return fmt.Errorf("remove recovered connector artifact: %w", err)
		}
	case currentErr != nil && !errors.Is(currentErr, os.ErrNotExist):
		return currentErr
	case retiredErr != nil && !errors.Is(retiredErr, os.ErrNotExist):
		return retiredErr
	}
	return nil
}

func (cache *DownloadCache) connectorRoot(connectorKey string) (string, error) {
	if !safeSegment(connectorKey) {
		return "", errors.New("connector cache key is invalid")
	}
	root := filepath.Join(cache.rootDir, connectorKey)
	if err := ensureWithin(cache.rootDir, root); err != nil {
		return "", err
	}
	return root, nil
}

func writeDownloadCacheReceipt(root string, receipt CachedArtifact) error {
	receipt.Path = ""
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	path := filepath.Join(root, downloadCacheReceiptFile)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("create connector download cache receipt: %w", err)
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
	return syncDirectory(root)
}
