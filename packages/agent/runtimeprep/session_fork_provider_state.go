package runtimeprep

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const codexHomeDirectory = "codex-home"

var errCodexRolloutNotFound = errors.New("codex rollout was not found")

type codexRolloutFingerprint struct {
	Size   int64
	SHA256 [sha256.Size]byte
}

type codexRolloutContentError struct {
	err error
}

func (e *codexRolloutContentError) Error() string {
	return e.err.Error()
}

func (e *codexRolloutContentError) Unwrap() error {
	return e.err
}

type codexRolloutMetadata struct {
	Type    string `json:"type"`
	Payload struct {
		ID        string `json:"id"`
		SessionID string `json:"session_id"`
	} `json:"payload"`
}

func (*DefaultPreparer) SupportsSessionForkProviderStateBinding(provider string) bool {
	return strings.EqualFold(strings.TrimSpace(provider), "codex")
}

func (p *DefaultPreparer) BindSessionForkProviderState(
	ctx context.Context,
	input SessionForkProviderStateBindingInput,
) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	input.Provider = strings.TrimSpace(input.Provider)
	if !strings.EqualFold(input.Provider, "codex") {
		return nil
	}
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.SourceAgentSessionID = strings.TrimSpace(input.SourceAgentSessionID)
	input.TargetAgentSessionID = strings.TrimSpace(input.TargetAgentSessionID)
	input.SourceProviderSessionID = strings.TrimSpace(input.SourceProviderSessionID)
	input.TargetProviderSessionID = strings.TrimSpace(input.TargetProviderSessionID)
	if input.WorkspaceID == "" ||
		input.SourceAgentSessionID == "" ||
		input.TargetAgentSessionID == "" ||
		input.SourceProviderSessionID == "" ||
		input.TargetProviderSessionID == "" ||
		input.SourceAgentSessionID == input.TargetAgentSessionID ||
		input.SourceProviderSessionID == input.TargetProviderSessionID {
		return errors.New("codex session fork provider state binding requires distinct source and target identities")
	}

	store := p.runtimeStore()
	sourceRoot, err := store.RuntimeRoot(input.WorkspaceID, input.SourceAgentSessionID)
	if err != nil {
		return fmt.Errorf("resolve source runtime root: %w", err)
	}
	targetRoot, err := store.RuntimeRoot(input.WorkspaceID, input.TargetAgentSessionID)
	if err != nil {
		return fmt.Errorf("resolve target runtime root: %w", err)
	}
	if err := store.EnsureRuntimeRoot(targetRoot); err != nil {
		return fmt.Errorf("ensure target runtime root: %w", err)
	}
	if err := syncDirectory(filepath.Dir(targetRoot)); err != nil {
		return fmt.Errorf("sync target runtime parent directory: %w", err)
	}

	sourceCodexHome := filepath.Join(sourceRoot, codexHomeDirectory)
	targetCodexHome := filepath.Join(targetRoot, codexHomeDirectory)
	if err := ensureDirectoryTreeWithoutSymlinks(
		targetRoot,
		targetCodexHome,
	); err != nil {
		return fmt.Errorf("prepare target Codex home: %w", err)
	}
	targetPath, _, targetFingerprint, targetErr := findCodexRollout(
		ctx,
		targetCodexHome,
		input.TargetProviderSessionID,
		true,
	)
	if targetErr != nil && !errors.Is(targetErr, errCodexRolloutNotFound) {
		var contentErr *codexRolloutContentError
		if targetPath == "" || !errors.As(targetErr, &contentErr) {
			return fmt.Errorf("inspect target Codex fork rollout: %w", targetErr)
		}
	}
	if err := validateExistingDirectoryTreeWithoutSymlinks(
		sourceRoot,
		sourceCodexHome,
	); err != nil {
		if errors.Is(err, fs.ErrNotExist) && targetErr == nil {
			return nil
		}
		return fmt.Errorf("validate source Codex home: %w", err)
	}
	sourcePath, relativePath, sourceFingerprint, err := findCodexRollout(
		ctx,
		sourceCodexHome,
		input.TargetProviderSessionID,
		false,
	)
	if err != nil {
		if errors.Is(err, errCodexRolloutNotFound) && targetErr == nil {
			return nil
		}
		return err
	}
	if targetErr != nil && targetPath != "" {
		if targetFingerprint.Size == 0 ||
			targetFingerprint.Size >= sourceFingerprint.Size {
			return errors.New("damaged target Codex rollout diverges from accepted provider child state")
		}
		sourceExtendsDamagedTarget, err := regularFileHasExactPrefix(
			sourcePath,
			targetPath,
			sourceFingerprint,
			targetFingerprint,
		)
		if err != nil {
			return fmt.Errorf("compare damaged target Codex rollout with fork baseline: %w", err)
		}
		if !sourceExtendsDamagedTarget {
			return errors.New("damaged target Codex rollout diverges from accepted provider child state")
		}
	}
	if targetErr == nil && targetFingerprint == sourceFingerprint {
		return nil
	}
	if targetErr == nil {
		switch {
		case targetFingerprint.Size > sourceFingerprint.Size:
			targetExtendsSource, err := regularFileHasExactPrefix(
				targetPath,
				sourcePath,
				targetFingerprint,
				sourceFingerprint,
			)
			if err != nil {
				return fmt.Errorf("compare target Codex rollout with fork baseline: %w", err)
			}
			if targetExtendsSource {
				return nil
			}
			return errors.New("target Codex rollout diverges from accepted provider child state")
		case targetFingerprint.Size < sourceFingerprint.Size:
			sourceExtendsTarget, err := regularFileHasExactPrefix(
				sourcePath,
				targetPath,
				sourceFingerprint,
				targetFingerprint,
			)
			if err != nil {
				return fmt.Errorf("compare truncated target Codex rollout with fork baseline: %w", err)
			}
			if !sourceExtendsTarget {
				return errors.New("target Codex rollout diverges from accepted provider child state")
			}
		default:
			return errors.New("target Codex rollout diverges from accepted provider child state")
		}
	}
	if targetPath == "" {
		targetPath = filepath.Join(targetCodexHome, relativePath)
	}
	if err := ensurePathWithin(targetCodexHome, targetPath); err != nil {
		return err
	}
	if err := ensureDirectoryTreeWithoutSymlinks(
		targetCodexHome,
		filepath.Dir(targetPath),
	); err != nil {
		return fmt.Errorf("prepare target Codex rollout directory: %w", err)
	}
	if err := copyRegularFileAtomically(
		sourcePath,
		targetPath,
		sourceFingerprint,
	); err != nil {
		return fmt.Errorf("copy Codex fork rollout into target runtime: %w", err)
	}
	targetMatches, targetFingerprint, err := inspectCodexRollout(
		targetPath,
		input.TargetProviderSessionID,
	)
	if err != nil {
		return fmt.Errorf("verify target Codex rollout: %w", err)
	}
	if !targetMatches || targetFingerprint != sourceFingerprint {
		return errors.New("copied Codex fork rollout does not exactly match accepted provider child state")
	}
	return nil
}

func findCodexRollout(
	ctx context.Context,
	codexHome string,
	targetProviderSessionID string,
	tolerateInvalidContent bool,
) (string, string, codexRolloutFingerprint, error) {
	var foundPath string
	var foundRelativePath string
	var foundFingerprint codexRolloutFingerprint
	var foundContentErr error
	for _, directory := range []string{"sessions", "archived_sessions"} {
		root := filepath.Join(codexHome, directory)
		walkErr := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				if errors.Is(walkErr, fs.ErrNotExist) {
					return nil
				}
				return walkErr
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if entry.IsDir() {
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 || !strings.Contains(entry.Name(), targetProviderSessionID) {
				return nil
			}
			matches, fingerprint, err := inspectCodexRollout(
				path,
				targetProviderSessionID,
			)
			inspectionErr := err
			if err != nil {
				var contentErr *codexRolloutContentError
				if tolerateInvalidContent && errors.As(err, &contentErr) {
					if !matches {
						return fmt.Errorf(
							"cannot verify target provider session identity for damaged Codex rollout %s: %w",
							path,
							err,
						)
					}
				} else {
					return err
				}
			}
			if !matches {
				return nil
			}
			relativePath, relativeErr := filepath.Rel(codexHome, path)
			if relativeErr != nil {
				return relativeErr
			}
			if foundPath != "" && foundPath != path {
				return fmt.Errorf("multiple Codex rollouts match provider session %s", targetProviderSessionID)
			}
			foundPath = path
			foundRelativePath = relativePath
			foundFingerprint = fingerprint
			if inspectionErr != nil {
				foundContentErr = inspectionErr
			}
			return nil
		})
		if walkErr != nil && !errors.Is(walkErr, fs.ErrNotExist) {
			return "", "", codexRolloutFingerprint{}, fmt.Errorf("scan Codex fork rollouts: %w", walkErr)
		}
	}
	if foundPath == "" {
		return "", "", codexRolloutFingerprint{}, fmt.Errorf(
			"%w for provider session %s",
			errCodexRolloutNotFound,
			targetProviderSessionID,
		)
	}
	if foundContentErr != nil {
		return foundPath, foundRelativePath, foundFingerprint, foundContentErr
	}
	return foundPath, foundRelativePath, foundFingerprint, nil
}

func codexRolloutMatches(path string, targetProviderSessionID string) (bool, error) {
	matches, _, err := inspectCodexRollout(path, targetProviderSessionID)
	return matches, err
}

func inspectCodexRollout(
	path string,
	targetProviderSessionID string,
) (bool, codexRolloutFingerprint, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return false, codexRolloutFingerprint{}, err
	}
	if !info.Mode().IsRegular() {
		return false, codexRolloutFingerprint{}, fmt.Errorf("codex rollout is not a regular file: %s", path)
	}
	file, err := os.Open(path)
	if err != nil {
		return false, codexRolloutFingerprint{}, err
	}
	defer file.Close()
	hasher := sha256.New()
	reader := bufio.NewReader(file)
	var metadata codexRolloutMetadata
	var metadataMatches bool
	var recordCount int
	var bytesRead int64
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 {
			bytesRead += int64(len(line))
			if _, err := hasher.Write(line); err != nil {
				return false, codexRolloutFingerprint{}, err
			}
			trimmed := bytes.TrimSpace(line)
			if len(trimmed) > 0 {
				if trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
					return metadataMatches, makeCodexRolloutFingerprint(bytesRead, hasher.Sum(nil)), &codexRolloutContentError{
						err: fmt.Errorf("codex rollout record %d is not a JSON object", recordCount+1),
					}
				}
				var record codexRolloutMetadata
				if err := json.Unmarshal(trimmed, &record); err != nil {
					return metadataMatches, makeCodexRolloutFingerprint(bytesRead, hasher.Sum(nil)), &codexRolloutContentError{
						err: fmt.Errorf("decode codex rollout record %d: %w", recordCount+1, err),
					}
				}
				if recordCount == 0 {
					metadata = record
					metadataMatches = record.Type == "session_meta" &&
						(strings.TrimSpace(record.Payload.ID) == targetProviderSessionID ||
							strings.TrimSpace(record.Payload.SessionID) == targetProviderSessionID)
				}
				recordCount++
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				return false, codexRolloutFingerprint{}, readErr
			}
			break
		}
	}
	if recordCount == 0 || bytesRead != info.Size() {
		return metadataMatches, makeCodexRolloutFingerprint(bytesRead, hasher.Sum(nil)), &codexRolloutContentError{
			err: errors.New("codex rollout is empty or changed while being validated"),
		}
	}
	fingerprint := makeCodexRolloutFingerprint(bytesRead, hasher.Sum(nil))
	if metadata.Type != "session_meta" {
		return false, fingerprint, nil
	}
	return metadataMatches, fingerprint, nil
}

func makeCodexRolloutFingerprint(size int64, sum []byte) codexRolloutFingerprint {
	var fingerprint codexRolloutFingerprint
	fingerprint.Size = size
	copy(fingerprint.SHA256[:], sum)
	return fingerprint
}

func regularFileHasExactPrefix(
	fullPath,
	prefixPath string,
	expectedFull,
	expectedPrefix codexRolloutFingerprint,
) (bool, error) {
	if expectedFull.Size < expectedPrefix.Size {
		return false, nil
	}
	prefixInfo, err := os.Lstat(prefixPath)
	if err != nil {
		return false, err
	}
	if !prefixInfo.Mode().IsRegular() {
		return false, fmt.Errorf("prefix rollout is not a regular file: %s", prefixPath)
	}
	prefix, err := os.Open(prefixPath)
	if err != nil {
		return false, err
	}
	defer prefix.Close()
	prefixHasher := sha256.New()
	prefixBytes, err := io.Copy(prefixHasher, prefix)
	if err != nil {
		return false, err
	}
	if prefixBytes != expectedPrefix.Size ||
		!bytes.Equal(prefixHasher.Sum(nil), expectedPrefix.SHA256[:]) {
		return false, errors.New("prefix Codex rollout changed while being compared")
	}

	fullInfo, err := os.Lstat(fullPath)
	if err != nil {
		return false, err
	}
	if !fullInfo.Mode().IsRegular() {
		return false, fmt.Errorf("full rollout is not a regular file: %s", fullPath)
	}
	full, err := os.Open(fullPath)
	if err != nil {
		return false, err
	}
	defer full.Close()
	fullHasher := sha256.New()
	fullPrefixHasher := sha256.New()
	fullPrefixBytes, err := io.CopyN(
		io.MultiWriter(fullHasher, fullPrefixHasher),
		full,
		expectedPrefix.Size,
	)
	if err != nil {
		return false, err
	}
	if fullPrefixBytes != expectedPrefix.Size {
		return false, errors.New("full Codex rollout changed while its prefix was being compared")
	}
	remainingBytes, err := io.Copy(fullHasher, full)
	if err != nil {
		return false, err
	}
	if fullPrefixBytes+remainingBytes != expectedFull.Size ||
		!bytes.Equal(fullHasher.Sum(nil), expectedFull.SHA256[:]) {
		return false, errors.New("full Codex rollout changed while being compared")
	}
	return bytes.Equal(fullPrefixHasher.Sum(nil), expectedPrefix.SHA256[:]), nil
}

func ensurePathWithin(root, path string) error {
	root = filepath.Clean(root)
	path = filepath.Clean(path)
	relativePath, err := filepath.Rel(root, path)
	if err != nil {
		return fmt.Errorf("validate target provider state path: %w", err)
	}
	if relativePath == "." || relativePath == ".." ||
		strings.HasPrefix(relativePath, ".."+string(filepath.Separator)) {
		return errors.New("target provider state path escapes target runtime")
	}
	return nil
}

func ensureDirectoryTreeWithoutSymlinks(root, directory string) error {
	if err := ensurePathWithin(root, filepath.Join(directory, "_")); err != nil {
		return err
	}
	relativeDirectory, err := filepath.Rel(root, directory)
	if err != nil {
		return err
	}
	current := filepath.Clean(root)
	for _, segment := range append(
		[]string{"."},
		strings.Split(relativeDirectory, string(filepath.Separator))...,
	) {
		if segment != "." {
			current = filepath.Join(current, segment)
		}
		info, statErr := os.Lstat(current)
		if statErr == nil {
			if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
				return fmt.Errorf("managed provider state directory is not a regular directory: %s", current)
			}
			continue
		}
		if !errors.Is(statErr, fs.ErrNotExist) {
			return statErr
		}
		if err := os.Mkdir(current, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
		if err := syncDirectory(filepath.Dir(current)); err != nil {
			return err
		}
	}
	return nil
}

func validateExistingDirectoryTreeWithoutSymlinks(root, directory string) error {
	if err := ensurePathWithin(root, filepath.Join(directory, "_")); err != nil {
		return err
	}
	relativeDirectory, err := filepath.Rel(root, directory)
	if err != nil {
		return err
	}
	current := filepath.Clean(root)
	for _, segment := range append(
		[]string{"."},
		strings.Split(relativeDirectory, string(filepath.Separator))...,
	) {
		if segment != "." {
			current = filepath.Join(current, segment)
		}
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return fmt.Errorf("managed provider state directory is not a regular directory: %s", current)
		}
	}
	return nil
}

func copyRegularFileAtomically(
	sourcePath,
	targetPath string,
	expected codexRolloutFingerprint,
) error {
	sourceInfo, err := os.Lstat(sourcePath)
	if err != nil {
		return err
	}
	if !sourceInfo.Mode().IsRegular() {
		return fmt.Errorf("source is not a regular file: %s", sourcePath)
	}
	targetDirectory := filepath.Dir(targetPath)
	temp, err := os.CreateTemp(targetDirectory, ".tutti-codex-fork-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer func() {
		_ = temp.Close()
		_ = os.Remove(tempPath)
	}()
	if err := temp.Chmod(sourceInfo.Mode().Perm()); err != nil {
		return err
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	hasher := sha256.New()
	copied, err := io.Copy(io.MultiWriter(temp, hasher), source)
	if err != nil {
		return err
	}
	if copied != expected.Size ||
		!bytes.Equal(hasher.Sum(nil), expected.SHA256[:]) {
		return errors.New("source Codex rollout changed while being copied")
	}
	if err := temp.Sync(); err != nil {
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		return err
	}
	return syncDirectory(targetDirectory)
}
