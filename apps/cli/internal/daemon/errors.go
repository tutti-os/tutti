package daemon

import (
	"errors"
	"strings"
)

type ErrorDetails struct {
	ReasonCode    string
	Message       string
	Retryable     bool
	CorrelationID string
	StatusCode    int
}

type requestError struct {
	details ErrorDetails
}

func (e *requestError) Error() string {
	if e == nil {
		return ""
	}
	return e.details.Message
}

func RequestErrorDetails(err error) (ErrorDetails, bool) {
	var requestErr *requestError
	if !errors.As(err, &requestErr) || requestErr == nil {
		return ErrorDetails{}, false
	}
	return requestErr.details, true
}

func newRequestError(details ErrorDetails) error {
	details.ReasonCode = strings.TrimSpace(details.ReasonCode)
	details.Message = strings.TrimSpace(details.Message)
	if details.ReasonCode == "" {
		details.ReasonCode = "daemon_request_failed"
	}
	if details.Message == "" {
		details.Message = details.ReasonCode
	}
	return &requestError{details: details}
}
