package workspace

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

var (
	ErrWorkflowRevisionDigestMismatch  = errors.New("workspace workflow revision digest does not match durable metadata")
	ErrInvalidWorkflowRevisionIdentity = errors.New("invalid workspace workflow revision identity")
	workflowRevisionIdentityPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	workflowRevisionDigestPattern      = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// WorkflowRevisionFiles is the local-file adapter for immutable workflow
// revision content. The service owns parsing and transitions; this adapter
// owns secure, content-addressed storage below the daemon state directory.
type WorkflowRevisionFiles struct {
	StateDir string
}

func (files WorkflowRevisionFiles) Write(workflowID string, raw []byte) (string, string, error) {
	workflowID = strings.TrimSpace(workflowID)
	if !workflowRevisionIdentityPattern.MatchString(workflowID) {
		return "", "", ErrInvalidWorkflowRevisionIdentity
	}
	digest := digestWorkflowRevision(raw)
	relativePath := workflowRevisionRelativePath(workflowID, digest)
	targetPath := filepath.Join(files.stateDir(), relativePath)
	directory := filepath.Dir(targetPath)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return "", "", fmt.Errorf("create workspace workflow revision directory: %w", err)
	}

	temporary, err := os.CreateTemp(directory, ".revision-*.tmp")
	if err != nil {
		return "", "", fmt.Errorf("create temporary workspace workflow revision: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return "", "", fmt.Errorf("secure temporary workspace workflow revision: %w", err)
	}
	if _, err := temporary.Write(raw); err != nil {
		return "", "", fmt.Errorf("write temporary workspace workflow revision: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return "", "", fmt.Errorf("sync temporary workspace workflow revision: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return "", "", fmt.Errorf("close temporary workspace workflow revision: %w", err)
	}

	if err := os.Link(temporaryPath, targetPath); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return "", "", fmt.Errorf("publish workspace workflow revision: %w", err)
		}
		existing, readErr := os.ReadFile(targetPath)
		if readErr != nil {
			return "", "", fmt.Errorf("read existing workspace workflow revision: %w", readErr)
		}
		if digestWorkflowRevision(existing) != digest {
			return "", "", ErrWorkflowRevisionDigestMismatch
		}
		return relativePath, digest, nil
	}
	if err := syncWorkflowRevisionDirectory(directory); err != nil {
		return "", "", err
	}
	return relativePath, digest, nil
}

func (files WorkflowRevisionFiles) Read(workflowID string, relativePath string, expectedDigest string) ([]byte, error) {
	workflowID = strings.TrimSpace(workflowID)
	expectedDigest = strings.ToLower(strings.TrimSpace(expectedDigest))
	cleanRelativePath := filepath.Clean(strings.TrimSpace(relativePath))
	if !workflowRevisionIdentityPattern.MatchString(workflowID) ||
		!workflowRevisionDigestPattern.MatchString(expectedDigest) ||
		cleanRelativePath != workflowRevisionRelativePath(workflowID, expectedDigest) {
		return nil, ErrInvalidWorkflowRevisionIdentity
	}
	raw, err := os.ReadFile(filepath.Join(files.stateDir(), cleanRelativePath))
	if err != nil {
		return nil, fmt.Errorf("read workspace workflow revision: %w", err)
	}
	if digestWorkflowRevision(raw) != expectedDigest {
		return nil, ErrWorkflowRevisionDigestMismatch
	}
	return raw, nil
}

func (files WorkflowRevisionFiles) stateDir() string {
	stateDir := strings.TrimSpace(files.StateDir)
	if stateDir == "" {
		return tuttitypes.DefaultStateDir()
	}
	return stateDir
}

func workflowRevisionRelativePath(workflowID string, digest string) string {
	return filepath.Join("tutti-mode-plans", workflowID, "revisions", digest+".md")
}

func digestWorkflowRevision(raw []byte) string {
	hash := sha256.Sum256(raw)
	return fmt.Sprintf("%x", hash[:])
}

func syncWorkflowRevisionDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open workspace workflow revision directory: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync workspace workflow revision directory: %w", err)
	}
	return nil
}
