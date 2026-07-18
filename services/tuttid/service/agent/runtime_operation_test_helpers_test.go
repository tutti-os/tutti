package agent

import (
	"strings"
	"time"

	"github.com/google/uuid"
)

const runtimeOperationLeaseDuration = 30 * time.Second

func runtimeOperationID(workspaceID, agentSessionID, kind, subjectID string) string {
	name := strings.Join([]string{
		strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID),
		strings.TrimSpace(kind), strings.TrimSpace(subjectID),
	}, "\x00")
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte(name)).String()
}

func payloadText(payload map[string]any, key string) string {
	value, _ := payload[key].(string)
	return strings.TrimSpace(value)
}
