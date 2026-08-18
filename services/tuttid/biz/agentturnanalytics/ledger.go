package agentturnanalytics

import (
	"strings"

	"github.com/google/uuid"
)

// terminalEventNamespace keeps a canonical Turn's analytics event identity
// stable across observer replays, daemon restarts, and outbox lease recovery.
var terminalEventNamespace = uuid.MustParse("7d9d3297-f7ca-5b83-a8f4-44c579b86f13")

type Settlement struct {
	WorkspaceID       string
	AgentSessionID    string
	TurnID            string
	EventID           string
	Provider          string
	Origin            string
	Outcome           string
	ErrorCode         string
	StartupReconciled bool
	StartedAtUnixMS   int64
	SettledAtUnixMS   int64
}

type Delivery struct {
	Settlement
	ClientSubmitID string
	MetadataJSON   string
}

func StableEventID(workspaceID, agentSessionID, turnID string) string {
	identity := strings.TrimSpace(workspaceID) + "\x00" +
		strings.TrimSpace(agentSessionID) + "\x00" + strings.TrimSpace(turnID)
	return uuid.NewSHA1(terminalEventNamespace, []byte(identity)).String()
}
