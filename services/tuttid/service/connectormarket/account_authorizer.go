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
	ppeLane      string
}

func NewAccountSessionAuthorizer(authJSONPath string, ppeLane string) (*AccountSessionAuthorizer, error) {
	authJSONPath = strings.TrimSpace(authJSONPath)
	if authJSONPath == "" {
		return nil, errors.New("account auth JSON path is required")
	}
	return &AccountSessionAuthorizer{authJSONPath: authJSONPath, ppeLane: strings.TrimSpace(ppeLane)}, nil
}

func (authorizer *AccountSessionAuthorizer) Authorize(request *http.Request) error {
	return authorizer.authorize(request, "")
}

func (authorizer *AccountSessionAuthorizer) AuthorizeForAccount(request *http.Request, expectedAccountID string) error {
	return authorizer.authorize(request, strings.TrimSpace(expectedAccountID))
}

func (authorizer *AccountSessionAuthorizer) CookieForAccount(accountID string) (string, error) {
	headers, err := authorizer.HeadersForAccount(accountID)
	if err != nil {
		return "", err
	}
	return headers.Get("Cookie"), nil
}

func (authorizer *AccountSessionAuthorizer) HeadersForAccount(accountID string) (http.Header, error) {
	request, err := http.NewRequest(http.MethodGet, "https://connector-authorization.invalid/", nil)
	if err != nil {
		return nil, err
	}
	if err := authorizer.AuthorizeForAccount(request, accountID); err != nil {
		return nil, err
	}
	return request.Header.Clone(), nil
}

func (authorizer *AccountSessionAuthorizer) authorize(request *http.Request, expectedAccountID string) error {
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
		UserID    string `json:"user_id"`
	}
	if err := json.Unmarshal(raw, &session); err != nil || strings.TrimSpace(session.SessionID) == "" || strings.TrimSpace(session.Cookie) == "" {
		return errors.New("connector market Tutti account session is invalid")
	}
	if expectedAccountID != "" && strings.TrimSpace(session.UserID) != expectedAccountID {
		return errors.New("connector market Tutti account changed during authorization sync")
	}
	request.Header.Set("Cookie", strings.TrimSpace(session.Cookie))
	if authorizer.ppeLane != "" {
		request.Header.Set("x-zk-ppe-lane", authorizer.ppeLane)
	}
	return nil
}
