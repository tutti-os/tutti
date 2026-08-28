package agentruntime

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

func TestClaudePreAcceptanceFailureSanitizesReturnedError(t *testing.T) {
	err := newClaudeSDKProviderRejectedError(Session{Provider: "claude-code"}, map[string]any{
		"code": "authentication_failed", "apiErrorStatus": float64(401),
		"error": "Authorization: Bearer must-not-escape",
	})
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr == nil {
		t.Fatalf("error = %#v", err)
	}
	if containsAny(err.Error(), "must-not-escape") || containsAny(appErr.DebugMessage, "must-not-escape") {
		t.Fatalf("unsanitized rejection error = %v debug=%q", err, appErr.DebugMessage)
	}
}

func TestClaudeProviderFailureClassification(t *testing.T) {
	tests := []struct {
		name       string
		code       string
		status     int64
		message    string
		wantCode   string
		wantImpact string
	}{
		{name: "auth", code: "authentication_failed", status: 401, wantCode: "auth_required", wantImpact: providerFailureAuthRequired},
		{name: "insufficient account balance", code: "authentication_failed", status: 403, message: "Failed to authenticate. API Error: 403 Insufficient account balance", wantCode: FailureCodeInsufficientCredits, wantImpact: providerFailureAuthNone},
		{name: "forbidden authentication error", code: "authentication_failed", status: 403, message: "Failed to authenticate. API Error: 403 Forbidden", wantCode: "provider_error", wantImpact: providerFailureAuthNone},
		{name: "org", code: "oauth_org_not_allowed", status: 403, wantCode: "account_not_allowed", wantImpact: providerFailureAuthNone},
		{name: "specific org beats status", code: "oauth_org_not_allowed", status: 401, wantCode: "account_not_allowed", wantImpact: providerFailureAuthNone},
		{name: "billing", code: "billing_error", status: 402, wantCode: "billing_error", wantImpact: providerFailureAuthNone},
		{name: "rate", code: "rate_limit", status: 429, wantCode: FailureCodeQuotaOrRateLimit, wantImpact: providerFailureAuthNone},
		{name: "overloaded", code: "overloaded", status: 503, wantCode: "provider_unavailable", wantImpact: providerFailureAuthNone},
		{name: "timeout", code: "server_error", status: 524, wantCode: "request_timed_out", wantImpact: providerFailureAuthNone},
		{name: "unknown forbidden", code: "unknown", status: 403, wantCode: "provider_error", wantImpact: providerFailureAuthNone},
		{name: "transport", code: "unknown", wantCode: "network_error", wantImpact: providerFailureAuthNone},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := map[string]any{"code": test.code, "error": firstNonEmptyString(test.message, "upstream detail")}
			if test.status != 0 {
				payload["apiErrorStatus"] = test.status
			}
			failure := claudeProviderFailure(payload)
			if failure.Code != test.wantCode || failure.AuthImpact != test.wantImpact {
				t.Fatalf("failure = %#v, want code=%q impact=%q", failure, test.wantCode, test.wantImpact)
			}
		})
	}
}

func TestAppServerProviderFailureUsesCodexErrorInfo(t *testing.T) {
	data := json.RawMessage(`{"message":"upstream rejected","additionalDetails":"details","codexErrorInfo":{"type":"unauthorized","httpStatusCode":401},"willRetry":false}`)
	failure := failureFromACPCall(&acpCallError{Method: "turn/start", Err: acpError{Code: -32000, Message: "wrapper", Data: data}})
	if failure.Code != "auth_required" || failure.ProviderCode != "unauthorized" || failure.HTTPStatus == nil || *failure.HTTPStatus != 401 || failure.AuthImpact != providerFailureAuthRequired {
		t.Fatalf("failure = %#v", failure)
	}
}

func TestCodexProviderFailureCoversProtocolVariants(t *testing.T) {
	tests := []struct {
		value    any
		wantCode string
		status   int
	}{
		{value: "unauthorized", wantCode: "auth_required"},
		{value: "usageLimitExceeded", wantCode: FailureCodeQuotaOrRateLimit},
		{value: "sessionBudgetExceeded", wantCode: FailureCodeQuotaOrRateLimit},
		{value: "serverOverloaded", wantCode: "provider_unavailable"},
		{value: "internalServerError", wantCode: "provider_unavailable"},
		{value: "badRequest", wantCode: "invalid_request"},
		{value: "contextWindowExceeded", wantCode: "invalid_request"},
		{value: "cyberPolicy", wantCode: "provider_error"},
		{value: map[string]any{"httpConnectionFailed": map[string]any{"httpStatusCode": float64(503)}}, wantCode: "provider_unavailable", status: 503},
		{value: map[string]any{"responseStreamConnectionFailed": map[string]any{"httpStatusCode": float64(524)}}, wantCode: "request_timed_out", status: 524},
		{value: map[string]any{"responseStreamDisconnected": map[string]any{"httpStatusCode": nil}}, wantCode: "provider_stream_disconnected"},
		{value: map[string]any{"responseTooManyFailedAttempts": map[string]any{"httpStatusCode": float64(429)}}, wantCode: FailureCodeQuotaOrRateLimit, status: 429},
		{value: map[string]any{"activeTurnNotSteerable": map[string]any{"turnKind": "review"}}, wantCode: "provider_error"},
	}
	for _, test := range tests {
		providerCode, status := codexFailureIdentity(test.value)
		code, authImpact, _ := codexFailureClassification(providerCode, status)
		if code != test.wantCode {
			t.Fatalf("codexErrorInfo=%#v providerCode=%q code=%q, want %q", test.value, providerCode, code, test.wantCode)
		}
		if code != "auth_required" && authImpact != providerFailureAuthNone {
			t.Fatalf("codexErrorInfo=%#v authImpact=%q", test.value, authImpact)
		}
		if test.status == 0 && status != nil {
			t.Fatalf("codexErrorInfo=%#v status=%v, want nil", test.value, status)
		}
		if test.status != 0 && (status == nil || *status != test.status) {
			t.Fatalf("codexErrorInfo=%#v status=%v, want %d", test.value, status, test.status)
		}
	}
}

func TestStandardACPUnknownErrorNeverInfersAuthenticationFromText(t *testing.T) {
	err := &acpCallError{Method: "session/prompt", Err: acpError{Code: -32000, Message: "auth token quota gateway error", Data: json.RawMessage(`{"message":"invalid api key"}`)}}
	failure := failureFromACPCall(err)
	if failure.Code != "provider_error" || failure.AuthImpact != providerFailureAuthNone || err.AuthRequired() {
		t.Fatalf("failure = %#v AuthRequired=%v", failure, err.AuthRequired())
	}
}

func TestStandardACPFailurePreservesSanitizedJSONRPCFacts(t *testing.T) {
	err := &acpCallError{Method: "session/prompt", Err: acpError{
		Code: -32042, Message: "relay rejected request",
		Data: json.RawMessage(`{"message":"model unavailable","apiKey":"must-not-persist","requestId":"req-1"}`),
	}}
	metadata := acpFailureMetadata(err)
	if metadata["code"] != "provider_error" || metadata["acpErrorCode"] != -32042 || metadata["acpErrorMessage"] != "relay rejected request" {
		t.Fatalf("metadata = %#v", metadata)
	}
	rawData, _ := metadata["acpErrorData"].(string)
	if !strings.Contains(rawData, `"requestId":"req-1"`) || strings.Contains(rawData, "must-not-persist") {
		t.Fatalf("sanitized ACP data = %q", rawData)
	}
}

func TestProviderFailureSanitizesSecretsBeforeMetadata(t *testing.T) {
	metadata := (ProviderFailure{Code: "provider_error", Message: "Authorization: Bearer secret-token\nCookie: session=first-secret; refresh=second-secret\nupstream headers: Set-Cookie: inline-secret; HttpOnly\nANTHROPIC_AUTH_TOKEN=env-secret\n{\"apiKey\":\"json-secret\",\"Cookie\":\"json-cookie-secret; other=value\"} https://example.test/?token=query-secret", Origin: providerFailureOriginProvider}).metadata()
	message, _ := metadata["error"].(string)
	if message == "" || containsAny(message, "secret-token", "first-secret", "second-secret", "inline-secret", "env-secret", "json-secret", "json-cookie-secret", "query-secret") {
		t.Fatalf("sanitized message = %q", message)
	}
}

func TestEveryRegisteredRuntimeKindHasFailureMapper(t *testing.T) {
	for _, descriptor := range providerregistry.Migrated() {
		switch descriptor.Runtime.Kind {
		case providerregistry.RuntimeKindClaudeSDK,
			providerregistry.RuntimeKindCodexAppServer,
			providerregistry.RuntimeKindStandardACP:
		default:
			t.Fatalf("provider %q has runtime kind %q without a failure mapper", descriptor.Identity.ID, descriptor.Runtime.Kind)
		}
	}
}

func containsAny(value string, candidates ...string) bool {
	for _, candidate := range candidates {
		if strings.Contains(value, candidate) {
			return true
		}
	}
	return false
}
