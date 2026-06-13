package workspacefiles

import (
	"context"
	"sync"
	"time"
)

const defaultDirectoryTreePrefetchConcurrency = 6

func (s Service) GetDirectoryTreeSnapshot(
	ctx context.Context,
	workspaceID string,
	input DirectoryTreeSnapshotInput,
) (DirectoryTreeSnapshot, error) {
	root, err := s.resolve(ctx, workspaceID)
	if err != nil {
		return DirectoryTreeSnapshot{}, err
	}

	logicalPath, err := NormalizeLogicalPathWithinRoot(input.Path, root.LogicalRoot)
	if err != nil {
		return DirectoryTreeSnapshot{}, err
	}

	listing, err := s.adapter().ListDirectory(ctx, root, logicalPath, input.IncludeHidden)
	if err != nil {
		return DirectoryTreeSnapshot{}, err
	}

	prefetchDepth := NormalizeDirectoryTreePrefetchDepth(input.PrefetchDepth)
	prefetchBudget := NormalizeDirectoryTreePrefetchBudget(input.PrefetchBudget)
	rootDirectory := buildDirectoryTreeDirectory(normalizeDirectoryListing(root, logicalPath, listing))
	rootDirectory.PrefetchState = DirectoryTreePrefetchStateLoaded

	if prefetchDepth > 1 {
		prefetchCtx, cancel := context.WithTimeout(ctx, prefetchBudget)
		defer cancel()

		sem := make(chan struct{}, defaultDirectoryTreePrefetchConcurrency)
		var waitGroup sync.WaitGroup

		for index := range rootDirectory.Entries {
			entry := &rootDirectory.Entries[index]
			if entry.Kind != EntryKindDirectory || !entry.HasChildren {
				continue
			}
			if !shouldPrefetchDirectory(s.adapter(), root, entry.Path) {
				markDirectoryTreeEntryPrefetchSkipped(entry)
				continue
			}
			waitGroup.Add(1)
			go func(item *DirectoryTreeEntry) {
				defer waitGroup.Done()
				sem <- struct{}{}
				defer func() {
					<-sem
				}()
				prefetchDirectoryTreeEntry(
					prefetchCtx,
					s.adapter(),
					root,
					input.IncludeHidden,
					prefetchDepth-1,
					item,
				)
			}(entry)
		}

		waitGroup.Wait()
		applyDirectoryTreeAggregateState(&rootDirectory)
	} else {
		for index := range rootDirectory.Entries {
			entry := &rootDirectory.Entries[index]
			if entry.Kind == EntryKindDirectory && entry.HasChildren {
				entry.PrefetchState = DirectoryTreePrefetchStateNotLoaded
				entry.PrefetchReason = DirectoryTreePrefetchReasonDepthLimitReached
			}
		}
		applyDirectoryTreeAggregateState(&rootDirectory)
	}

	return DirectoryTreeSnapshot{
		WorkspaceID:      root.WorkspaceID,
		Root:             NormalizeLogicalRoot(root.LogicalRoot),
		Directory:        rootDirectory,
		PrefetchBudgetMs: prefetchBudget.Milliseconds(),
		PrefetchDepth:    prefetchDepth,
		BudgetExceeded:   hasBudgetLimitedPrefetch(rootDirectory),
	}, nil
}

func NormalizeDirectoryTreePrefetchDepth(value int) int {
	if value <= 0 {
		return DefaultDirectoryTreePrefetchDepth
	}
	if value > MaxDirectoryTreePrefetchDepth {
		return MaxDirectoryTreePrefetchDepth
	}
	return value
}

func NormalizeDirectoryTreePrefetchBudget(value time.Duration) time.Duration {
	if value <= 0 {
		return DefaultDirectoryTreePrefetchBudget
	}
	if value > MaxDirectoryTreePrefetchBudget {
		return MaxDirectoryTreePrefetchBudget
	}
	return value
}

func buildDirectoryTreeDirectory(listing DirectoryListing) DirectoryTreeDirectory {
	entries := make([]DirectoryTreeEntry, 0, len(listing.Entries))
	for _, entry := range listing.Entries {
		entries = append(entries, DirectoryTreeEntry{
			Path:          entry.Path,
			Name:          entry.Name,
			Kind:          entry.Kind,
			HasChildren:   entry.HasChildren,
			SizeBytes:     entry.SizeBytes,
			MtimeMs:       entry.MtimeMs,
			CreatedTimeMs: entry.CreatedTimeMs,
			LastOpenedMs:  entry.LastOpenedMs,
		})
	}

	return DirectoryTreeDirectory{
		DirectoryPath: listing.DirectoryPath,
		Entries:       entries,
		PrefetchState: DirectoryTreePrefetchStateLoaded,
	}
}

func prefetchDirectoryTreeEntry(
	ctx context.Context,
	adapter FileAdapter,
	root WorkspaceRoot,
	includeHidden bool,
	depth int,
	entry *DirectoryTreeEntry,
) {
	if entry.Kind != EntryKindDirectory {
		return
	}
	if !entry.HasChildren {
		entry.PrefetchState = DirectoryTreePrefetchStateLoaded
		return
	}
	if depth <= 0 {
		entry.PrefetchState = DirectoryTreePrefetchStateNotLoaded
		entry.PrefetchReason = DirectoryTreePrefetchReasonDepthLimitReached
		return
	}
	if ctx.Err() != nil {
		entry.PrefetchState = DirectoryTreePrefetchStateNotLoaded
		entry.PrefetchReason = DirectoryTreePrefetchReasonBudgetExhausted
		return
	}
	if !shouldPrefetchDirectory(adapter, root, entry.Path) {
		markDirectoryTreeEntryPrefetchSkipped(entry)
		return
	}

	listing, err := adapter.ListDirectory(ctx, root, entry.Path, includeHidden)
	if err != nil {
		if ctx.Err() != nil {
			entry.PrefetchState = DirectoryTreePrefetchStateNotLoaded
			entry.PrefetchReason = DirectoryTreePrefetchReasonBudgetExhausted
			return
		}
		entry.PrefetchState = DirectoryTreePrefetchStateUnavailable
		entry.PrefetchReason = DirectoryTreePrefetchReasonUnreadable
		return
	}

	directory := buildDirectoryTreeDirectory(listing)
	if depth > 1 {
		for index := range directory.Entries {
			child := &directory.Entries[index]
			if child.Kind != EntryKindDirectory || !child.HasChildren {
				continue
			}
			prefetchDirectoryTreeEntry(
				ctx,
				adapter,
				root,
				includeHidden,
				depth-1,
				child,
			)
		}
	} else {
		for index := range directory.Entries {
			child := &directory.Entries[index]
			if child.Kind != EntryKindDirectory || !child.HasChildren {
				continue
			}
			child.PrefetchState = DirectoryTreePrefetchStateNotLoaded
			child.PrefetchReason = DirectoryTreePrefetchReasonDepthLimitReached
		}
	}
	applyDirectoryTreeAggregateState(&directory)

	entry.PrefetchedDirectory = &directory
	entry.PrefetchState = directory.PrefetchState
	entry.PrefetchReason = directory.PrefetchReason
}

func applyDirectoryTreeAggregateState(directory *DirectoryTreeDirectory) {
	state := DirectoryTreePrefetchStateLoaded
	reason := DirectoryTreePrefetchReasonNone

	for index := range directory.Entries {
		entry := directory.Entries[index]
		if entry.Kind != EntryKindDirectory || !entry.HasChildren {
			continue
		}
		switch entry.PrefetchState {
		case DirectoryTreePrefetchStatePartial,
			DirectoryTreePrefetchStateNotLoaded,
			DirectoryTreePrefetchStateUnavailable:
			state = DirectoryTreePrefetchStatePartial
			if reason == DirectoryTreePrefetchReasonNone {
				reason = entry.PrefetchReason
			}
		case "":
			state = DirectoryTreePrefetchStatePartial
			if reason == DirectoryTreePrefetchReasonNone {
				reason = DirectoryTreePrefetchReasonDepthLimitReached
			}
		}
	}

	directory.PrefetchState = state
	directory.PrefetchReason = reason
}

func hasBudgetLimitedPrefetch(directory DirectoryTreeDirectory) bool {
	if directory.PrefetchReason == DirectoryTreePrefetchReasonBudgetExhausted {
		return true
	}
	for _, entry := range directory.Entries {
		if entry.PrefetchReason == DirectoryTreePrefetchReasonBudgetExhausted {
			return true
		}
		if entry.PrefetchedDirectory != nil && hasBudgetLimitedPrefetch(*entry.PrefetchedDirectory) {
			return true
		}
	}
	return false
}

func shouldPrefetchDirectory(adapter FileAdapter, root WorkspaceRoot, path LogicalPath) bool {
	policy, ok := adapter.(DirectoryTreePrefetchPolicy)
	if !ok {
		return true
	}
	return policy.ShouldPrefetchDirectory(root, path)
}

func markDirectoryTreeEntryPrefetchSkipped(entry *DirectoryTreeEntry) {
	entry.PrefetchState = DirectoryTreePrefetchStateNotLoaded
	entry.PrefetchReason = DirectoryTreePrefetchReasonDepthLimitReached
}
