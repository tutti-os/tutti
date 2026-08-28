package agentruntime

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

const (
	providerFailureOriginProvider  = "provider"
	providerFailureOriginTransport = "transport"
	providerFailureAuthNone        = "none"
	providerFailureAuthRequired    = "required"
)

// ProviderFailure is the normalized boundary between provider protocols and
// canonical activity. Provider adapters own classification; shared layers must
// not infer authentication state from provider prose.
type ProviderFailure struct {
	Code              string
	ProviderCode      string
	HTTPStatus        *int
	Message           string
	AdditionalDetails string
	Retryable         *bool
	Origin            string
	AuthImpact        string
	AuthReason        string
}

func (failure ProviderFailure) metadata() map[string]any {
	message := sanitizeProviderFailureText(failure.Message)
	details := sanitizeProviderFailureText(failure.AdditionalDetails)
	payload := map[string]any{
		"code":       firstNonEmptyString(strings.TrimSpace(failure.Code), "provider_error"),
		"origin":     firstNonEmptyString(strings.TrimSpace(failure.Origin), providerFailureOriginProvider),
		"authImpact": firstNonEmptyString(strings.TrimSpace(failure.AuthImpact), providerFailureAuthNone),
	}
	if message != "" {
		payload["error"] = message
		payload["errorMessage"] = message
	}
	if details != "" && details != message {
		payload["additionalDetails"] = details
	}
	if code := strings.TrimSpace(failure.ProviderCode); code != "" {
		payload["providerCode"] = code
	}
	if failure.HTTPStatus != nil {
		payload["httpStatus"] = *failure.HTTPStatus
	}
	if failure.Retryable != nil {
		payload["retryable"] = *failure.Retryable
	}
	if failure.AuthImpact == providerFailureAuthRequired {
		payload["authReason"] = firstNonEmptyString(strings.TrimSpace(failure.AuthReason), "auth_required")
	}
	return payload
}

func claudeProviderFailure(payload map[string]any) ProviderFailure {
	providerCode := strings.TrimSpace(payloadString(payload, "code"))
	message := strings.TrimSpace(payloadString(payload, "error"))
	statusValue := payloadInt64(payload, "apiErrorStatus")
	var status *int
	if statusValue > 0 {
		value := int(statusValue)
		status = &value
	}
	failure := ProviderFailure{
		Code:         "provider_error",
		ProviderCode: providerCode,
		HTTPStatus:   status,
		Message:      firstNonEmptyString(message, providerCode, "Claude provider rejected the Turn before acceptance"),
		Origin:       providerFailureOriginProvider,
		AuthImpact:   providerFailureAuthNone,
	}
	switch providerCode {
	case "authentication_failed":
		// Claude's SDK also uses this code for some HTTP 403 account failures;
		// only a real 401 (or a missing status) is an authentication gate.
		if claudeProviderInsufficientAccountBalance(message) {
			failure.Code = FailureCodeInsufficientCredits
		} else if status == nil || *status == 401 {
			failure.Code, failure.AuthImpact, failure.AuthReason = "auth_required", providerFailureAuthRequired, "authentication_failed"
		}
	case "oauth_org_not_allowed":
		failure.Code = "account_not_allowed"
	case "billing_error":
		failure.Code = "billing_error"
	case "rate_limit":
		failure.Code = FailureCodeQuotaOrRateLimit
	case "overloaded", "server_error":
		failure.Code = "provider_unavailable"
	case "invalid_request":
		failure.Code = "invalid_request"
	case "model_not_found":
		failure.Code = "model_not_available"
	case "max_output_tokens":
		failure.Code = "max_output_tokens"
	case "unknown":
		if status == nil {
			failure.Code = "network_error"
			failure.Origin = providerFailureOriginTransport
		}
	}
	if status != nil {
		switch *status {
		case 401:
			if providerCode == "" || providerCode == "unknown" || providerCode == "authentication_failed" {
				failure.Code, failure.AuthImpact, failure.AuthReason = "auth_required", providerFailureAuthRequired, "http_401"
			}
		case 408, 522, 524:
			failure.Code = "request_timed_out"
		default:
			if *status >= 500 && failure.Code == "provider_error" {
				failure.Code = "provider_unavailable"
			}
		}
	}
	return failure
}

func claudeProviderInsufficientAccountBalance(message string) bool {
	return strings.Contains(strings.ToLower(message), "insufficient account balance")
}

func failureFromACPCall(err *acpCallError) ProviderFailure {
	failure := ProviderFailure{
		Code:       "provider_error",
		Message:    err.Err.Message,
		Origin:     providerFailureOriginProvider,
		AuthImpact: providerFailureAuthNone,
	}
	data := acpErrorDataPayload(err.Err.Data)
	if message := strings.TrimSpace(asString(data["message"])); message != "" {
		failure.Message = message
	}
	if details := firstNonEmpty(asString(data["additional_details"]), asString(data["additionalDetails"])); details != "" {
		failure.AdditionalDetails = details
	}
	info := firstPresentAny(data["codex_error_info"], data["codexErrorInfo"])
	providerCode, httpStatus := codexFailureIdentity(info)
	if providerCode != "" {
		failure.ProviderCode = providerCode
		failure.HTTPStatus = httpStatus
		failure.Code, failure.AuthImpact, failure.AuthReason = codexFailureClassification(providerCode, httpStatus)
	}
	if retryable, ok := firstPresentAny(data["will_retry"], data["willRetry"]).(bool); ok {
		failure.Retryable = &retryable
	}
	failure.Message = firstNonEmptyString(failure.Message, failure.AdditionalDetails, failure.ProviderCode, "Provider request failed")
	return failure
}

func failureFromCodexTurnError(turnError map[string]any) ProviderFailure {
	providerCode, httpStatus := codexFailureIdentity(turnError["codexErrorInfo"])
	code, authImpact, authReason := codexFailureClassification(providerCode, httpStatus)
	message := asStringRaw(turnError["message"])
	details := asStringRaw(turnError["additionalDetails"])
	failure := ProviderFailure{
		Code:              code,
		ProviderCode:      providerCode,
		HTTPStatus:        httpStatus,
		Message:           firstNonEmptyString(message, details, providerCode, "Codex provider request failed"),
		AdditionalDetails: details,
		Origin:            providerFailureOriginProvider,
		AuthImpact:        authImpact,
		AuthReason:        authReason,
	}
	if retryable, ok := turnError["willRetry"].(bool); ok {
		failure.Retryable = &retryable
	}
	return failure
}

func codexFailureIdentity(value any) (string, *int) {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed), nil
	case map[string]any:
		code := firstNonEmpty(asString(typed["type"]), asString(typed["code"]), asString(typed["kind"]))
		if code == "" && len(typed) == 1 {
			for key, nested := range typed {
				code = key
				if object, ok := nested.(map[string]any); ok {
					typed = object
				}
			}
		}
		var status *int
		for _, candidate := range []any{typed["httpStatusCode"], typed["http_status_code"]} {
			if parsed, ok := providerFailureInt(candidate); ok {
				status = &parsed
				break
			}
		}
		return strings.TrimSpace(code), status
	default:
		return "", nil
	}
}

func codexFailureClassification(providerCode string, httpStatus *int) (string, string, string) {
	normalized := strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(strings.TrimSpace(providerCode)))
	switch normalized {
	case "unauthorized":
		return "auth_required", providerFailureAuthRequired, "unauthorized"
	case "usagelimitexceeded", "sessionbudgetexceeded":
		return FailureCodeQuotaOrRateLimit, providerFailureAuthNone, ""
	case "serveroverloaded", "internalservererror":
		return "provider_unavailable", providerFailureAuthNone, ""
	case "badrequest", "contextwindowexceeded":
		return "invalid_request", providerFailureAuthNone, ""
	}
	if httpStatus != nil {
		switch {
		case *httpStatus == 408 || *httpStatus == 522 || *httpStatus == 524:
			return "request_timed_out", providerFailureAuthNone, ""
		case *httpStatus == 429:
			return FailureCodeQuotaOrRateLimit, providerFailureAuthNone, ""
		case *httpStatus >= 500:
			return "provider_unavailable", providerFailureAuthNone, ""
		}
	}
	switch normalized {
	case "httpconnectionfailed", "responsestreamconnectionfailed", "responsestreamdisconnected", "responsetoomanyfailedattempts":
		return "provider_stream_disconnected", providerFailureAuthNone, ""
	default:
		return "provider_error", providerFailureAuthNone, ""
	}
}

func providerFailureInt(value any) (int, bool) {
	switch typed := value.(type) {
	case float64:
		return int(typed), true
	case int:
		return typed, true
	case json.Number:
		parsed, err := strconv.Atoi(string(typed))
		return parsed, err == nil
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		return parsed, err == nil
	default:
		return 0, false
	}
}

var providerFailureSecretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)("(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret|signature)"\s*:\s*")[^"]*`),
	regexp.MustCompile(`(?i)(\b(?:cookie|set-cookie)\s*:\s*)[^\r\n]*`),
	regexp.MustCompile(`(?i)((?:"?(?:authorization|proxy-authorization|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|secret|signature)"?)\s*[:=]\s*"?(?:bearer\s+)?)[^"\s,;}]+`),
	regexp.MustCompile(`(?i)([?&](?:api[_-]?key|key|token|signature)=)[^&\s]+`),
}

func sanitizeProviderFailureText(value string) string {
	value = cleanVisibleErrorText(value)
	for _, pattern := range providerFailureSecretPatterns {
		value = pattern.ReplaceAllString(value, `${1}[REDACTED]`)
	}
	return limitVisibleErrorDetail(value)
}
