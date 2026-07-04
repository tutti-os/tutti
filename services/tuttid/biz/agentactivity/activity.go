package agentactivity

import "context"

type Repository interface {
	ClearSessions(context.Context, string) (ClearSessionsResult, error)
	DeleteSession(context.Context, string, string) (bool, error)
	GetSession(context.Context, string, string) (Session, bool, error)
	ListSessionSection(context.Context, ListSessionSectionInput) (SessionSectionPage, bool, error)
	ListSessions(context.Context, string) ([]Session, bool, error)
	ListWorkspaceGeneratedFiles(context.Context, ListWorkspaceGeneratedFilesInput) (GeneratedFileList, bool, error)
	ListSessionMessages(context.Context, ListSessionMessagesInput) (MessagePage, bool, error)
	ReportSessionMessages(context.Context, SessionMessageReport) (MessageReportResult, error)
	ReportSessionState(context.Context, SessionStateReport) (StateReportResult, error)
	UpdateSessionPinned(context.Context, string, string, bool) (Session, bool, error)
}

type ClearSessionsResult struct {
	RemovedMessages   int
	RemovedSessions   int
	RemovedSessionIDs []string
}

type MessageOrder string

const (
	MessageOrderAsc  MessageOrder = "asc"
	MessageOrderDesc MessageOrder = "desc"
)

type ListSessionMessagesInput struct {
	WorkspaceID    string
	AgentSessionID string
	TurnID         string
	AfterVersion   uint64
	BeforeVersion  uint64
	Limit          int
	Order          MessageOrder
}

type ListWorkspaceGeneratedFilesInput struct {
	WorkspaceID string
	Query       string
	SessionCwd  string
	Limit       int
}

type GeneratedFile struct {
	Path  string
	Label string
}

type GeneratedFileList struct {
	WorkspaceID string
	Files       []GeneratedFile
}

type ListSessionSectionInput struct {
	WorkspaceID       string
	SectionKey        string
	AgentTargetID     string
	CursorUpdatedAtMS int64
	CursorSessionID   string
	Limit             int
}

type SessionSectionPage struct {
	WorkspaceID   string
	SectionKey    string
	Sessions      []Session
	HasMore       bool
	NextCursor    string
	NextUpdatedAt int64
}

type Session struct {
	ID                string
	WorkspaceID       string
	Origin            string
	AgentTargetID     string
	Provider          string
	ProviderSessionID string
	Model             string
	Settings          map[string]any
	RuntimeContext    map[string]any
	Cwd               string
	Status            string
	CurrentPhase      string
	Title             string
	LastError         string
	MessageVersion    uint64
	LastEventUnixMS   int64
	StartedAtUnixMS   int64
	EndedAtUnixMS     int64
	PinnedAtUnixMS    int64
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
}

type SessionStateReport struct {
	WorkspaceID       string
	AgentSessionID    string
	Origin            string
	AgentTargetID     string
	Provider          string
	ProviderSessionID string
	Model             string
	Settings          map[string]any
	RuntimeContext    map[string]any
	Cwd               string
	Title             string
	Status            string
	CurrentPhase      string
	LastError         string
	OccurredAtUnixMS  int64
	StartedAtUnixMS   int64
	EndedAtUnixMS     int64
}

type StateReportResult struct {
	Accepted         bool
	StateApplied     bool
	LastEventUnixMS  int64
	RequestBodyBytes int
	Session          Session
}

type SessionMessageReport struct {
	WorkspaceID    string
	AgentSessionID string
	Origin         string
	Provider       string
	Messages       []MessageUpdate
}

type MessageUpdate struct {
	MessageID         string
	TurnID            string
	Role              string
	Kind              string
	Status            string
	ContentDelta      string
	Payload           map[string]any
	OccurredAtUnixMS  int64
	StartedAtUnixMS   int64
	CompletedAtUnixMS int64
}

type MessageReportResult struct {
	AcceptedCount    int
	LatestVersion    uint64
	Messages         []Message
	RequestBodyBytes int
}

type Message struct {
	ID                uint64
	AgentSessionID    string
	MessageID         string
	Version           uint64
	TurnID            string
	Role              string
	Kind              string
	Status            string
	Payload           map[string]any
	OccurredAtUnixMS  int64
	StartedAtUnixMS   int64
	CompletedAtUnixMS int64
	CreatedAtUnixMS   int64
	UpdatedAtUnixMS   int64
}

type MessagePage struct {
	AgentSessionID string
	Messages       []Message
	LatestVersion  uint64
	HasMore        bool
}
