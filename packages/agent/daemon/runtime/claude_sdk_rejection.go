package agentruntime

import (
	"errors"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type claudeSDKProviderRejectedError struct {
	providerError *AppError
}

func (e *claudeSDKProviderRejectedError) Error() string {
	if e == nil || e.providerError == nil {
		return "Claude provider rejected the Turn"
	}
	return e.providerError.Error()
}

func (e *claudeSDKProviderRejectedError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.providerError
}

func newClaudeSDKProviderRejectedError(
	session Session,
	payload map[string]any,
) error {
	failure := claudeProviderFailure(payload)
	detail := sanitizeProviderFailureText(failure.Message)
	return &claudeSDKProviderRejectedError{providerError: &AppError{
		Code:         failure.Code,
		Message:      visibleFailureContent(session.Provider, "turn", failure.Code),
		DebugMessage: detail,
		Cause:        errors.New(detail),
	}}
}

func isClaudeSDKProviderRejectedError(err error) bool {
	var rejected *claudeSDKProviderRejectedError
	return errors.As(err, &rejected)
}

func ensureClaudeSDKPreAcceptanceFailureEvent(
	events []activityshared.Event,
	session Session,
	turnID string,
	payload map[string]any,
	rejected bool,
) []activityshared.Event {
	hasTurnFailed := false
	for _, event := range events {
		if event.Type == activityshared.EventTurnFailed {
			hasTurnFailed = true
			break
		}
	}
	if !hasTurnFailed {
		metadata := claudeProviderFailure(payload).metadata()
		metadata["stopReason"] = "failed_before_provider_acceptance"
		for key, value := range map[string]any{
			"stopReason":     "failed_before_provider_acceptance",
			"code":           payloadString(payload, "code"),
			"error":          payloadString(payload, "error"),
			"apiErrorStatus": payloadInt64(payload, "apiErrorStatus"),
		} {
			if _, exists := metadata[key]; !exists {
				metadata[key] = value
			}
		}
		if rejected {
			metadata["dispatchDisposition"] = string(DispatchDispositionRejected)
		}
		events = append(events, newTurnActivityEvent(
			session, EventTurnFailed, turnID, SessionStatusFailed, "", "", metadata,
		))
	}
	if !rejected {
		return events
	}
	for index := range events {
		if events[index].Type != activityshared.EventTurnFailed {
			continue
		}
		if events[index].Payload.Metadata == nil {
			events[index].Payload.Metadata = make(map[string]any)
		}
		events[index].Payload.Metadata["dispatchDisposition"] = string(DispatchDispositionRejected)
	}
	return events
}
