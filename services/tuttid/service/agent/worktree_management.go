package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

func (s *Service) ListManagedWorktrees(
	_ context.Context,
	workspaceID string,
) ([]ManagedWorktree, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if s == nil || workspaceID == "" {
		return nil, ErrInvalidArgument
	}
	s.worktreeLock().RLock()
	defer s.worktreeLock().RUnlock()
	worktreesRoot := filepath.Join(s.worktreeStateDir(), "agent", "worktrees")
	entries, err := os.ReadDir(worktreeRecordsDir(worktreesRoot))
	if errors.Is(err, os.ErrNotExist) {
		return []ManagedWorktree{}, nil
	}
	if err != nil {
		return nil, err
	}
	result := make([]ManagedWorktree, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		record, readErr := readManagedWorktreeRecord(
			filepath.Join(worktreeRecordsDir(worktreesRoot), entry.Name()),
		)
		if readErr != nil {
			return nil, fmt.Errorf("read managed worktree metadata %q: %w", entry.Name(), readErr)
		}
		if strings.TrimSpace(record.WorkspaceID) != workspaceID {
			continue
		}
		result = append(result, managedWorktreeFromRecord(record))
	}
	sort.Slice(result, func(i, j int) bool { return result[i].WorktreeID < result[j].WorktreeID })
	return result, nil
}

func managedWorktreeFromRecord(record managedWorktreeRecord) ManagedWorktree {
	return ManagedWorktree{
		WorktreeID:   strings.TrimSpace(record.WorktreeID),
		WorkspaceID:  strings.TrimSpace(record.WorkspaceID),
		RepoRoot:     strings.TrimSpace(record.RepoRoot),
		WorktreePath: strings.TrimSpace(record.WorktreePath),
		Branch:       strings.TrimSpace(record.Branch),
		BaseCommit:   strings.TrimSpace(record.BaseCommit),
		RelativeCwd:  strings.TrimSpace(record.RelativeCwd),
	}
}

func (s *Service) DeleteManagedWorktree(
	ctx context.Context,
	workspaceID string,
	worktreeID string,
) (bool, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	worktreeID = strings.TrimSpace(worktreeID)
	if s == nil || workspaceID == "" || !safeManagedWorktreeID(worktreeID) {
		return false, ErrInvalidArgument
	}
	s.worktreeLock().Lock()
	defer s.worktreeLock().Unlock()
	worktreesRoot := filepath.Join(s.worktreeStateDir(), "agent", "worktrees")
	recordPath := worktreeRecordPath(worktreesRoot, worktreeID)
	record, err := readManagedWorktreeRecord(recordPath)
	if errors.Is(err, os.ErrNotExist) {
		return false, ErrManagedWorktreeNotFound
	}
	if err != nil {
		return false, err
	}
	if strings.TrimSpace(record.WorkspaceID) != workspaceID || record.WorktreeID != worktreeID {
		return false, ErrManagedWorktreeNotFound
	}
	worktreeExists := true
	if _, statErr := os.Stat(record.WorktreePath); errors.Is(statErr, os.ErrNotExist) {
		worktreeExists = false
	} else if statErr != nil {
		return false, statErr
	}
	if worktreeExists {
		status, statusErr := gitOutput(ctx, record.WorktreePath, "status", "--porcelain")
		if statusErr != nil {
			return false, statusErr
		}
		if strings.TrimSpace(status) != "" {
			return false, ErrManagedWorktreeDirty
		}
	}
	branchRef := "refs/heads/" + record.Branch
	branchOID, branchExists, err := managedWorktreeBranchOID(ctx, record, branchRef)
	if err != nil {
		return false, err
	}
	if branchExists {
		aheadText, aheadErr := gitRepoOutput(ctx, record, "rev-list", "--count", record.BaseCommit+".."+branchRef)
		if aheadErr != nil {
			return false, aheadErr
		}
		ahead, parseErr := strconv.Atoi(strings.TrimSpace(aheadText))
		if parseErr != nil {
			return false, parseErr
		}
		if ahead != 0 {
			return false, ErrManagedWorktreeAhead
		}
	}
	if worktreeExists {
		if _, removeErr := gitRepoOutput(ctx, record, "worktree", "remove", record.WorktreePath); removeErr != nil {
			return false, removeErr
		}
	}
	if branchExists {
		if branchErr := deleteManagedWorktreeBranch(ctx, record, branchRef, branchOID); branchErr != nil {
			return false, branchErr
		}
	}
	if _, pruneErr := gitRepoOutput(ctx, record, "worktree", "prune"); pruneErr != nil {
		return false, pruneErr
	}
	if removeErr := os.Remove(recordPath); removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
		return false, removeErr
	}
	return true, nil
}

func deleteManagedWorktreeBranch(
	ctx context.Context,
	record managedWorktreeRecord,
	branchRef string,
	expectedOID string,
) error {
	if _, err := gitRepoOutput(ctx, record, "update-ref", "-d", branchRef, expectedOID); err != nil {
		return fmt.Errorf("%w: %v", ErrManagedWorktreeChanged, err)
	}
	return nil
}

func managedWorktreeBranchOID(
	ctx context.Context,
	record managedWorktreeRecord,
	branchRef string,
) (string, bool, error) {
	_, err := gitRepoOutput(ctx, record, "show-ref", "--verify", "--quiet", branchRef)
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return "", false, nil
		}
		return "", false, err
	}
	oid, err := gitRepoOutput(ctx, record, "rev-parse", "--verify", branchRef)
	if err != nil {
		return "", false, err
	}
	oid = strings.TrimSpace(oid)
	if oid == "" {
		return "", false, errors.New("managed worktree branch has no object id")
	}
	return oid, true, nil
}

func safeManagedWorktreeID(worktreeID string) bool {
	return worktreeID != "" && filepath.Base(worktreeID) == worktreeID &&
		!strings.ContainsAny(worktreeID, `/\\`)
}
