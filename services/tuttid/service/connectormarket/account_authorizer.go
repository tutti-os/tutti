package connectormarket

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
)

// AccountSessionAuthorizer is the Tutti host adapter for TSH user-session
// authentication. The shared market domain never reads account files or owns
// HTTP authentication.
type AccountSessionAuthorizer struct {
	authJSONPath string
}

func NewAccountSessionAuthorizer(authJSONPath string) (*AccountSessionAuthorizer, error) {
	authJSONPath = strings.TrimSpace(authJSONPath)
	if authJSONPath == "" {
		return nil, errors.New("account auth JSON path is required")
	}
	return &AccountSessionAuthorizer{authJSONPath: authJSONPath}, nil
}

func (authorizer *AccountSessionAuthorizer) Authorize(request *http.Request) error {
	if authorizer == nil || request == nil {
		return errors.New("connector market account authorizer is unavailable")
	}
	raw, err := os.ReadFile(authorizer.authJSONPath)
	if err != nil {
		return errors.New("connector market requires an authenticated Tutti account")
	}
	var session struct {
		SessionID string `json:"session_id"`
		Cookie    string `json:"cookie"`
	}
	if err := json.Unmarshal(raw, &session); err != nil || strings.TrimSpace(session.SessionID) == "" || strings.TrimSpace(session.Cookie) == "" {
		return errors.New("connector market Tutti account session is invalid")
	}
	request.Header.Set("Cookie", strings.TrimSpace(session.Cookie))
	return nil
}
