package artifact

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const TreeInventoryAlgorithmV1 = "tutti.connector.tree.v1"

type TreeIdentity struct {
	Algorithm         string
	SHA256            string
	FileCount         int
	ExpandedSizeBytes int64
}

// ExtractArchive applies the same portable-path, file-type, duplicate,
// expansion, and compression-ratio policy used for signed Connector artifacts.
func ExtractArchive(archivePath, format, destination string, limits Limits) error {
	if limits == (Limits{}) {
		limits = DefaultLimits()
	}
	if err := validateLimits(limits); err != nil {
		return err
	}
	preparer := &Preparer{limits: limits}
	switch format {
	case "zip":
		return preparer.extractZIP(archivePath, destination)
	case "tar_gzip":
		return preparer.extractTarGzip(archivePath, destination)
	default:
		return fmt.Errorf("unsupported managed archive format %q", format)
	}
}

func InspectTree(root string) (TreeIdentity, error) {
	digest, err := inventoryDigest(root)
	if err != nil {
		return TreeIdentity{}, err
	}
	identity := TreeIdentity{Algorithm: TreeInventoryAlgorithmV1, SHA256: digest}
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root || entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return errors.New("managed archive inventory contains an unsupported file type")
		}
		identity.FileCount++
		identity.ExpandedSizeBytes += info.Size()
		return nil
	})
	if err != nil {
		return TreeIdentity{}, fmt.Errorf("inspect managed archive tree: %w", err)
	}
	return identity, nil
}

func RemoveAllWithin(root, target string) error { return removeAllWithin(root, target) }

func SyncDirectory(path string) error { return syncDirectory(path) }
