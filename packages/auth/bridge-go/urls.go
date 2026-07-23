package authbridge

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
)

func buildLoginURL(authLoginURL string, state string) string {
	u, _ := url.Parse(authLoginURL)
	u.Path = "/auth/login"
	u.RawQuery = ""
	u.Fragment = ""
	q := u.Query()
	q.Set("state", state)
	u.RawQuery = q.Encode()
	return u.String()
}

func redirectBridgeResult(w http.ResponseWriter, r *http.Request, attempt *LoginAttempt, status string, safeErrorCode string) {
	http.Redirect(w, r, buildBridgeResultURL(attempt.client.config, status, safeErrorCode), http.StatusFound)
}

func buildBridgeResultURL(config Config, status string, safeErrorCode string) string {
	u, err := url.Parse(config.AuthLoginURL)
	if err != nil {
		return "/auth/login/callback"
	}
	u.Path = "/auth/login/callback"
	u.RawQuery = ""
	u.Fragment = ""
	q := u.Query()
	q.Set("desktopBridgeStatus", status)
	if strings.TrimSpace(safeErrorCode) != "" {
		q.Set("desktopBridgeError", strings.TrimSpace(safeErrorCode))
	}
	if openAppURL := buildSafeOpenAppURLForResult(config.AppCallbackURL, status, safeErrorCode); openAppURL != "" {
		q.Set("openAppUrl", openAppURL)
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func callbackErrorValue(value string) error {
	if strings.TrimSpace(value) == "user_cancelled" {
		return ErrUserCancelled
	}
	return errors.New(strings.TrimSpace(value))
}

func callbackErrorSafeResultCode(value string) string {
	if strings.TrimSpace(value) == "user_cancelled" {
		return "userCancelled"
	}
	return "providerError"
}

func buildSafeOpenAppURLForResult(raw string, status string, safeErrorCode string) string {
	if safeErrorCode == "userCancelled" {
		return ""
	}
	return buildSafeOpenAppURL(raw, status, safeErrorCode)
}

func buildSafeOpenAppURL(raw string, status string, safeErrorCode string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !isAllowedAppCallbackScheme(u.Scheme) {
		return ""
	}
	u.RawQuery = ""
	u.Fragment = ""
	q := u.Query()
	q.Set("desktopBridgeStatus", status)
	if strings.TrimSpace(safeErrorCode) != "" {
		q.Set("desktopBridgeError", strings.TrimSpace(safeErrorCode))
	}
	u.RawQuery = q.Encode()
	return u.String()
}
