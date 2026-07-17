package agent

type ExternalImportScanInput struct {
	Providers []string
	// Days limits the scan window to conversations updated within the last N
	// days. 0 keeps the default 30-day window; a negative value scans all
	// available history. Archive scans (ArchivePath set) are the exception:
	// the export is a complete snapshot, so 0 also scans the full archive and
	// only an explicit positive value narrows the window.
	Days int
	// ArchivePath selects a supported provider data-export ZIP instead of the
	// provider's local CLI transcript directory.
	ArchivePath string
}

type ExternalImportInput struct {
	Projects    []ExternalImportProjectSelection
	ArchivePath string
}

type ExternalImportProjectSelection struct {
	Path       string
	Providers  []string
	SessionIDs []string
}

type ExternalImportScanResult struct {
	Providers       []ExternalImportProvider
	Projects        []ExternalImportProject
	Sessions        []ExternalImportSession
	ScannedSessions int
	ScannedMessages int
	SkippedSessions int
	Errors          []ExternalImportError
}

type ExternalImportProvider struct {
	Provider     string
	Root         string
	Available    bool
	SessionCount int
	MessageCount int
	Error        string
}

type ExternalImportProject struct {
	Path                string
	Label               string
	Providers           []string
	SessionCount        int
	MessageCount        int
	LastUpdatedAtUnixMS int64
}

type ExternalImportSession struct {
	ID                  string
	ProjectPath         string
	Provider            string
	SourcePath          string
	Title               string
	MessageCount        int
	LastUpdatedAtUnixMS int64
}

type ExternalImportError struct {
	Provider   string
	SourcePath string
	Message    string
}

type ExternalImportResult struct {
	ImportedProjects int
	ImportedSessions int
	ImportedMessages int
	SkippedSessions  int
	Errors           []ExternalImportError
	// ProjectPaths lists the selected project paths that matched at least one
	// valid imported session. Callers use it to avoid registering user projects
	// that would surface with no sessions underneath them.
	ProjectPaths []string
}

type externalImportedSession struct {
	Provider          string
	ProviderSessionID string
	SourcePath        string
	Cwd               string
	Title             string
	// SummaryTitle holds an authoritative, provider-supplied conversation title
	// (e.g. Claude `custom-title`/`summary` transcript lines or the Codex
	// app-server `threads.title`). When present it wins over message-derived
	// titles.
	SummaryTitle     string
	NoProject        bool
	EventUserMessage externalImportedMessage
	StartedAtUnixMS  int64
	UpdatedAtUnixMS  int64
	Messages         []externalImportedMessage
	Turns            []externalImportedTurn
	// Model and ReasoningEffort capture the provider-reported model/effort the
	// local CLI was actually using (Codex `turn_context.model`/`effort`,
	// Claude Code `message.model`) so imported sessions preserve the user's
	// local model configuration instead of falling back to workspace defaults
	// when the conversation is continued.
	Model           string
	ReasoningEffort string
	// ResumeSupported is nil for legacy/local transcript imports, which remain
	// continuable. Archive-only histories set it to false because claude.ai
	// conversation IDs are not Claude Code runtime session IDs.
	ResumeSupported *bool
}

type externalImportedMessage struct {
	RawID             string
	MessageIDSeed     string
	TurnID            string
	Role              string
	Kind              string
	Status            string
	Text              string
	Payload           map[string]any
	OccurredAtUnixMS  int64
	StartedAtUnixMS   int64
	CompletedAtUnixMS int64
}

type externalImportedTurn struct {
	TurnID          string
	StartedAtUnixMS int64
	SettledAtUnixMS int64
}

type externalScanData struct {
	result   ExternalImportScanResult
	sessions []externalImportedSession
}
