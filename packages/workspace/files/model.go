package workspacefiles

import "time"

const DefaultLogicalRoot = "/"
const (
	DefaultDirectoryTreePrefetchDepth  = 4
	DefaultDirectoryTreePrefetchBudget = 500 * time.Millisecond
	DefaultReadFileMaxBytes            = 20 * 1024 * 1024
	MaxDirectoryTreePrefetchDepth      = 8
	MaxDirectoryTreePrefetchBudget     = 5 * time.Second
)

type EntryKind string

const (
	EntryKindFile      EntryKind = "file"
	EntryKindDirectory EntryKind = "directory"
	EntryKindUnknown   EntryKind = "unknown"
)

type LogicalPath string

func (p LogicalPath) String() string {
	return string(p)
}

type WorkspaceRoot struct {
	WorkspaceID  string
	LogicalRoot  string
	PhysicalRoot string
}

type FileEntry struct {
	Path          LogicalPath
	Name          string
	Kind          EntryKind
	HasChildren   bool
	SizeBytes     *int64
	MtimeMs       *int64
	CreatedTimeMs *int64
	LastOpenedMs  *int64
}

type FileContent struct {
	Path      LogicalPath
	Name      string
	Bytes     []byte
	SizeBytes int64
}

type DirectoryListing struct {
	WorkspaceID   string
	Root          LogicalPath
	DirectoryPath LogicalPath
	Entries       []FileEntry
}

type DirectoryListInput struct {
	IncludeHidden bool
	Path          string
}

type DirectoryTreePrefetchState string

const (
	DirectoryTreePrefetchStateLoaded      DirectoryTreePrefetchState = "loaded"
	DirectoryTreePrefetchStateNotLoaded   DirectoryTreePrefetchState = "not_loaded"
	DirectoryTreePrefetchStatePartial     DirectoryTreePrefetchState = "partial"
	DirectoryTreePrefetchStateUnavailable DirectoryTreePrefetchState = "unavailable"
)

type DirectoryTreePrefetchReason string

const (
	DirectoryTreePrefetchReasonNone              DirectoryTreePrefetchReason = ""
	DirectoryTreePrefetchReasonBudgetExhausted   DirectoryTreePrefetchReason = "budget_exhausted"
	DirectoryTreePrefetchReasonDepthLimitReached DirectoryTreePrefetchReason = "depth_limit_reached"
	DirectoryTreePrefetchReasonUnreadable        DirectoryTreePrefetchReason = "unreadable"
)

type DirectoryTreeSnapshotInput struct {
	IncludeHidden  bool
	Path           string
	PrefetchBudget time.Duration
	PrefetchDepth  int
}

type DirectoryTreeEntry struct {
	Path                LogicalPath
	Name                string
	Kind                EntryKind
	HasChildren         bool
	SizeBytes           *int64
	MtimeMs             *int64
	CreatedTimeMs       *int64
	LastOpenedMs        *int64
	PrefetchReason      DirectoryTreePrefetchReason
	PrefetchState       DirectoryTreePrefetchState
	PrefetchedDirectory *DirectoryTreeDirectory
}

type DirectoryTreeDirectory struct {
	DirectoryPath  LogicalPath
	Entries        []DirectoryTreeEntry
	PrefetchReason DirectoryTreePrefetchReason
	PrefetchState  DirectoryTreePrefetchState
}

type DirectoryTreeSnapshot struct {
	WorkspaceID      string
	Root             LogicalPath
	Directory        DirectoryTreeDirectory
	PrefetchBudgetMs int64
	PrefetchDepth    int
	BudgetExceeded   bool
}

type SearchInput struct {
	IncludeKinds  []EntryKind
	IncludeHidden bool
	Limit         int
	Query         string
	Deadline      time.Time
}

type SearchMatchTarget string

const (
	SearchMatchTargetBasename SearchMatchTarget = "basename"
	SearchMatchTargetPath     SearchMatchTarget = "path"
)

type UploadInput struct {
	Overwrite           bool
	SourcePaths         []string
	TargetDirectoryPath string
}

type UploadConflictKind string

const (
	UploadConflictKindReplaceable  UploadConflictKind = "replaceable"
	UploadConflictKindTypeMismatch UploadConflictKind = "type_mismatch"
)

type UploadConflict struct {
	DestinationKind EntryKind
	DestinationPath LogicalPath
	Kind            UploadConflictKind
	Name            string
	SourcePath      string
}

type PreflightUploadInput struct {
	SourcePaths         []string
	TargetDirectoryPath string
}

type PreflightUploadResult struct {
	WorkspaceID         string
	Root                LogicalPath
	TargetDirectoryPath LogicalPath
	Conflicts           []UploadConflict
}

type UploadResult struct {
	WorkspaceID         string
	Root                LogicalPath
	TargetDirectoryPath LogicalPath
	Entries             []FileEntry
}

type SearchEntry struct {
	Path          LogicalPath
	Name          string
	Kind          EntryKind
	DirectoryPath LogicalPath
	MatchIndices  []int
	MatchTarget   SearchMatchTarget
	Score         int
}

type SearchResult struct {
	WorkspaceID string
	Root        LogicalPath
	Entries     []SearchEntry
}

type SearchCandidate struct {
	Kind         EntryKind
	RelativePath string
}
