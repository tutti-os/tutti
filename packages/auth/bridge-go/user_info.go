package authbridge

import (
	"strings"
	"time"
)

func buildAccountURL(baseURL string, path string) string {
	return strings.TrimRight(baseURL, "/") + "/" + strings.TrimLeft(path, "/")
}

func buildSessionCookie(sessionID string) string {
	return "session_id=" + strings.TrimSpace(sessionID)
}

func sessionFromUser(sessionID string, user UserInfo) Session {
	return Session{
		SessionID: strings.TrimSpace(sessionID),
		Cookie:    buildSessionCookie(sessionID),
		UserID:    user.UserID,
		Name:      user.Name,
		AssetURL:  user.AssetURL,
		AssetRef:  user.AssetRef,
		Email:     user.Email,
		UpdatedAt: time.Now().UnixMilli(),
	}
}

func mapUserInfo(data map[string]any) UserInfo {
	return UserInfo{
		UserID:   stringField(data, "userId", "user_id"),
		Name:     stringField(data, "name"),
		Email:    stringField(data, "email", "userEmail", "emailAddress"),
		AssetURL: stringField(data, "assetUrl"),
		AssetRef: stringField(data, "assetRef"),
	}
}

func stringField(data map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := data[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
