package agentstatus

import (
	"encoding/json"
	"os"
	"strings"
)

type openCodeAuthRecord struct {
	Type    string `json:"type"`
	Key     string `json:"key"`
	Token   string `json:"token"`
	Access  string `json:"access"`
	Refresh string `json:"refresh"`
}

// parseOpenCodeAuthMarkerFile follows OpenCode's auth.json contract: the top
// level maps provider IDs to api, oauth, or wellknown credential records. An
// empty object, malformed record, or blank secret means login is still needed.
func parseOpenCodeAuthMarkerFile(path string) (AuthInfo, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return AuthInfo{}, false
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil || payload == nil {
		return AuthInfo{}, false
	}
	for providerID, rawRecord := range payload {
		var record openCodeAuthRecord
		if err := json.Unmarshal(rawRecord, &record); err != nil {
			continue
		}
		if !usableOpenCodeAuthRecord(record) {
			continue
		}
		return AuthInfo{
			Status:       AuthAuthenticated,
			AccountLabel: strings.TrimSpace(providerID),
			AuthMethod:   strings.TrimSpace(record.Type),
		}, true
	}
	return AuthInfo{Status: AuthRequired}, true
}

func usableOpenCodeAuthRecord(record openCodeAuthRecord) bool {
	switch strings.ToLower(strings.TrimSpace(record.Type)) {
	case "api":
		return strings.TrimSpace(record.Key) != ""
	case "oauth":
		return strings.TrimSpace(record.Access) != "" || strings.TrimSpace(record.Refresh) != ""
	case "wellknown":
		return strings.TrimSpace(record.Key) != "" && strings.TrimSpace(record.Token) != ""
	default:
		return false
	}
}
