package types

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"strings"
)

const (
	ErrorCodeInvalidRequest     = "invalid_request"
	ErrorCodeMethodNotAllowed   = "method_not_allowed"
	ErrorCodeServiceUnavailable = "service_unavailable"
	ErrorCodeUnauthorized       = "unauthorized"
)

type APIErrorDetails struct {
	Code             string         `json:"code"`
	Reason           string         `json:"reason,omitempty"`
	Params           map[string]any `json:"params,omitempty"`
	Retryable        bool           `json:"retryable,omitempty"`
	DeveloperMessage string         `json:"developerMessage,omitempty"`
	CorrelationID    string         `json:"correlationId,omitempty"`
}

type APIErrorResponse struct {
	Error APIErrorDetails `json:"error"`
}

func WriteMethodNotAllowed(w http.ResponseWriter) {
	WriteError(w, http.StatusMethodNotAllowed, ErrorCodeMethodNotAllowed, "method_not_allowed", "method not allowed")
}

func WriteError(w http.ResponseWriter, code int, errorCode string, reason string, developerMessage string) {
	WriteJSON(w, code, APIErrorResponse{
		Error: APIErrorDetails{
			Code:             errorCode,
			Reason:           reason,
			DeveloperMessage: developerMessage,
		},
	})
}

func WriteJSON(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

func WithCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}

		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Credentials", "true")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

type BearerTokenAuthorizer func(*http.Request, string) bool

func WithBearerTokenAuthFunc(expectedToken string, authorizer BearerTokenAuthorizer, next http.Handler) http.Handler {
	expectedToken = strings.TrimSpace(expectedToken)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token, ok := bearerTokenFromHeader(r.Header.Get("Authorization"))
		if !ok && isWebSocketUpgrade(r) {
			token, ok = bearerTokenFromQuery(r)
		}
		authorized := ok && expectedToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(expectedToken)) == 1
		if !authorized && ok && authorizer != nil {
			authorized = authorizer(r, token)
		}
		if !authorized {
			WriteError(
				w,
				http.StatusUnauthorized,
				ErrorCodeUnauthorized,
				"missing_or_invalid_token",
				"daemon request is not authorized",
			)
			return
		}

		next.ServeHTTP(w, r)
	})
}

func EnvOrDefault(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}

	return value
}

func bearerTokenFromHeader(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", false
	}

	scheme, token, found := strings.Cut(value, " ")
	if !found || !strings.EqualFold(strings.TrimSpace(scheme), "Bearer") {
		return "", false
	}

	token = strings.TrimSpace(token)
	if token == "" {
		return "", false
	}

	return token, true
}

func bearerTokenFromQuery(r *http.Request) (string, bool) {
	token := strings.TrimSpace(r.URL.Query().Get("access_token"))
	if token == "" {
		return "", false
	}
	return token, true
}

func isWebSocketUpgrade(r *http.Request) bool {
	return strings.EqualFold(strings.TrimSpace(r.Header.Get("Upgrade")), "websocket")
}
