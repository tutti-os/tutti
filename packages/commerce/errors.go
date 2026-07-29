package commerce

import (
	"context"
	"errors"
	"fmt"
	"net/http"
)

const (
	ErrorCodeUnauthorized = "unauthorized"
	ErrorCodeTimeout      = "timeout"
	ErrorCodeUnavailable  = "unavailable"
)

var (
	ErrBaseURLRequired                     = errors.New("commerce base URL is required")
	ErrRequestAuthorizerRequired           = errors.New("commerce request authorizer is required")
	ErrRewardReceiptStoreRequired          = errors.New("commerce reward receipt store is required")
	ErrRegistrationCreditsRewardIDRequired = errors.New("registration credits reward id is required")
)

type HTTPError struct {
	StatusCode int
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("commerce request failed with status %d", e.StatusCode)
}

func ErrorCode(err error) string {
	if err == nil {
		return ""
	}
	var httpError *HTTPError
	if errors.As(err, &httpError) {
		if httpError.StatusCode == http.StatusUnauthorized ||
			httpError.StatusCode == http.StatusForbidden {
			return ErrorCodeUnauthorized
		}
		return fmt.Sprintf("http_%d", httpError.StatusCode)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return ErrorCodeTimeout
	}
	return ErrorCodeUnavailable
}
