package workspace

import (
	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

func GeneratedFileDirectoryResponseFromDomain(
	listing workspacefiles.DirectoryListing,
) tuttigenerated.WorkspaceFileDirectoryResponse {
	return tuttigenerated.WorkspaceFileDirectoryResponse{
		WorkspaceId:   listing.WorkspaceID,
		Root:          listing.Root.String(),
		DirectoryPath: listing.DirectoryPath.String(),
		Entries:       GeneratedFileEntriesFromDomain(listing.Entries),
	}
}

func GeneratedFileTreeSnapshotResponseFromDomain(
	snapshot workspacefiles.DirectoryTreeSnapshot,
) tuttigenerated.WorkspaceFileTreeSnapshotResponse {
	return tuttigenerated.WorkspaceFileTreeSnapshotResponse{
		BudgetExceeded:   snapshot.BudgetExceeded,
		Directory:        generatedFileTreeDirectoryFromDomain(snapshot.Directory),
		PrefetchBudgetMs: snapshot.PrefetchBudgetMs,
		PrefetchDepth:    snapshot.PrefetchDepth,
		Root:             snapshot.Root.String(),
		WorkspaceId:      snapshot.WorkspaceID,
	}
}

func GeneratedFileEntryResponseFromDomain(
	workspaceID string,
	root workspacefiles.LogicalPath,
	entry workspacefiles.FileEntry,
) tuttigenerated.WorkspaceFileEntryResponse {
	return tuttigenerated.WorkspaceFileEntryResponse{
		WorkspaceId: workspaceID,
		Root:        root.String(),
		Entry:       GeneratedFileEntryFromDomain(entry),
	}
}

func GeneratedFileEntriesFromDomain(items []workspacefiles.FileEntry) []tuttigenerated.WorkspaceFileEntry {
	if len(items) == 0 {
		return []tuttigenerated.WorkspaceFileEntry{}
	}

	result := make([]tuttigenerated.WorkspaceFileEntry, 0, len(items))
	for _, item := range items {
		result = append(result, GeneratedFileEntryFromDomain(item))
	}
	return result
}

func GeneratedFileEntryFromDomain(item workspacefiles.FileEntry) tuttigenerated.WorkspaceFileEntry {
	return tuttigenerated.WorkspaceFileEntry{
		Path:          item.Path.String(),
		Name:          item.Name,
		Kind:          generatedFileEntryKind(item.Kind),
		HasChildren:   item.HasChildren,
		SizeBytes:     item.SizeBytes,
		MtimeMs:       item.MtimeMs,
		CreatedTimeMs: item.CreatedTimeMs,
		LastOpenedMs:  item.LastOpenedMs,
	}
}

func GeneratedFileSearchResponseFromDomain(
	result workspacefiles.SearchResult,
) tuttigenerated.WorkspaceFileSearchResponse {
	entries := make([]tuttigenerated.WorkspaceFileSearchEntry, 0, len(result.Entries))
	for _, entry := range result.Entries {
		entries = append(entries, tuttigenerated.WorkspaceFileSearchEntry{
			Path:          entry.Path.String(),
			Name:          entry.Name,
			Kind:          generatedFileEntryKind(entry.Kind),
			DirectoryPath: entry.DirectoryPath.String(),
			MatchIndices:  searchMatchIndicesToGenerated(entry.MatchIndices),
			MatchTarget:   generatedSearchMatchTarget(entry.MatchTarget),
			Score:         entry.Score,
		})
	}

	return tuttigenerated.WorkspaceFileSearchResponse{
		WorkspaceId: result.WorkspaceID,
		Root:        result.Root.String(),
		Entries:     entries,
	}
}

func generatedFileTreeDirectoryFromDomain(
	directory workspacefiles.DirectoryTreeDirectory,
) tuttigenerated.WorkspaceFileTreeDirectory {
	result := tuttigenerated.WorkspaceFileTreeDirectory{
		DirectoryPath: directory.DirectoryPath.String(),
		Entries:       generatedFileTreeEntriesFromDomain(directory.Entries),
		PrefetchState: generatedFileTreePrefetchState(directory.PrefetchState),
	}
	if directory.PrefetchReason != workspacefiles.DirectoryTreePrefetchReasonNone {
		reason := generatedFileTreePrefetchReason(directory.PrefetchReason)
		result.PrefetchReason = &reason
	}
	return result
}

func generatedFileTreeEntriesFromDomain(
	entries []workspacefiles.DirectoryTreeEntry,
) []tuttigenerated.WorkspaceFileTreeEntry {
	if len(entries) == 0 {
		return []tuttigenerated.WorkspaceFileTreeEntry{}
	}

	result := make([]tuttigenerated.WorkspaceFileTreeEntry, 0, len(entries))
	for _, entry := range entries {
		item := tuttigenerated.WorkspaceFileTreeEntry{
			CreatedTimeMs: entry.CreatedTimeMs,
			HasChildren:   entry.HasChildren,
			Kind:          generatedFileEntryKind(entry.Kind),
			LastOpenedMs:  entry.LastOpenedMs,
			MtimeMs:       entry.MtimeMs,
			Name:          entry.Name,
			Path:          entry.Path.String(),
			SizeBytes:     entry.SizeBytes,
		}
		if entry.PrefetchState != "" {
			state := generatedFileTreePrefetchState(entry.PrefetchState)
			item.PrefetchState = &state
		}
		if entry.PrefetchReason != workspacefiles.DirectoryTreePrefetchReasonNone {
			reason := generatedFileTreePrefetchReason(entry.PrefetchReason)
			item.PrefetchReason = &reason
		}
		if entry.PrefetchedDirectory != nil {
			directory := generatedFileTreeDirectoryFromDomain(*entry.PrefetchedDirectory)
			item.PrefetchedDirectory = &directory
		}
		result = append(result, item)
	}
	return result
}

func searchMatchIndicesToGenerated(indices []int) []int {
	if len(indices) == 0 {
		return []int{}
	}
	result := make([]int, len(indices))
	copy(result, indices)
	return result
}

func GeneratedFileUploadResponseFromDomain(
	result workspacefiles.UploadResult,
) tuttigenerated.UploadWorkspaceFilesResponse {
	return tuttigenerated.UploadWorkspaceFilesResponse{
		WorkspaceId:         result.WorkspaceID,
		Root:                result.Root.String(),
		TargetDirectoryPath: result.TargetDirectoryPath.String(),
		Entries:             GeneratedFileEntriesFromDomain(result.Entries),
	}
}

func GeneratedFilePreflightUploadResponseFromDomain(
	result workspacefiles.PreflightUploadResult,
) tuttigenerated.PreflightUploadWorkspaceFilesResponse {
	conflicts := make([]tuttigenerated.WorkspaceFileUploadConflict, 0, len(result.Conflicts))
	for _, conflict := range result.Conflicts {
		conflicts = append(conflicts, tuttigenerated.WorkspaceFileUploadConflict{
			DestinationKind: generatedFileEntryKind(conflict.DestinationKind),
			DestinationPath: conflict.DestinationPath.String(),
			Kind:            generatedUploadConflictKind(conflict.Kind),
			Name:            conflict.Name,
			SourcePath:      conflict.SourcePath,
		})
	}

	return tuttigenerated.PreflightUploadWorkspaceFilesResponse{
		WorkspaceId:         result.WorkspaceID,
		Root:                result.Root.String(),
		TargetDirectoryPath: result.TargetDirectoryPath.String(),
		Conflicts:           conflicts,
	}
}

func DomainEntryKindFromGenerated(
	kind *tuttigenerated.WorkspaceFileFilterKind,
) workspacefiles.EntryKind {
	if kind == nil {
		return ""
	}
	switch *kind {
	case tuttigenerated.WorkspaceFileFilterKindFile:
		return workspacefiles.EntryKindFile
	case tuttigenerated.WorkspaceFileFilterKindDirectory:
		return workspacefiles.EntryKindDirectory
	default:
		return workspacefiles.EntryKindUnknown
	}
}

func DomainSearchKindsFromGenerated(
	kinds *tuttigenerated.WorkspaceFileSearchKinds,
) []workspacefiles.EntryKind {
	if kinds == nil || len(*kinds) == 0 {
		return nil
	}

	result := make([]workspacefiles.EntryKind, 0, len(*kinds))
	for _, kind := range *kinds {
		switch kind {
		case tuttigenerated.WorkspaceFileFilterKindFile:
			result = append(result, workspacefiles.EntryKindFile)
		case tuttigenerated.WorkspaceFileFilterKindDirectory:
			result = append(result, workspacefiles.EntryKindDirectory)
		default:
			result = append(result, workspacefiles.EntryKindUnknown)
		}
	}
	return result
}

func generatedFileEntryKind(kind workspacefiles.EntryKind) tuttigenerated.WorkspaceFileEntryKind {
	switch kind {
	case workspacefiles.EntryKindFile:
		return tuttigenerated.File
	case workspacefiles.EntryKindDirectory:
		return tuttigenerated.Directory
	default:
		return tuttigenerated.Unknown
	}
}

func generatedFileTreePrefetchState(
	state workspacefiles.DirectoryTreePrefetchState,
) tuttigenerated.WorkspaceFileTreePrefetchState {
	return tuttigenerated.WorkspaceFileTreePrefetchState(state)
}

func generatedFileTreePrefetchReason(
	reason workspacefiles.DirectoryTreePrefetchReason,
) tuttigenerated.WorkspaceFileTreePrefetchReason {
	return tuttigenerated.WorkspaceFileTreePrefetchReason(reason)
}

func generatedUploadConflictKind(
	kind workspacefiles.UploadConflictKind,
) tuttigenerated.WorkspaceFileUploadConflictKind {
	switch kind {
	case workspacefiles.UploadConflictKindTypeMismatch:
		return tuttigenerated.TypeMismatch
	default:
		return tuttigenerated.Replaceable
	}
}

func generatedSearchMatchTarget(
	target workspacefiles.SearchMatchTarget,
) tuttigenerated.WorkspaceFileSearchMatchTarget {
	switch target {
	case workspacefiles.SearchMatchTargetPath:
		return tuttigenerated.WorkspaceFileSearchMatchTargetPath
	default:
		return tuttigenerated.WorkspaceFileSearchMatchTargetBasename
	}
}
