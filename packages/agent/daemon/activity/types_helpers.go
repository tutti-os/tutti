package agentsessionstore

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
)

func firstNonZeroFlexibleInt64(values ...flexibleInt64) flexibleInt64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func firstNonZeroFlexibleUint64(values ...flexibleUint64) flexibleUint64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

type HTTPError struct {
	StatusCode int
	Body       string
	Header     http.Header
}

func (e HTTPError) Error() string {
	if strings.TrimSpace(e.Body) == "" {
		return fmt.Sprintf("agent activity request failed (%d)", e.StatusCode)
	}
	return fmt.Sprintf("agent activity request failed (%d): %s", e.StatusCode, e.Body)
}

type requestBodySizedError struct {
	err              error
	requestBodyBytes int
}

func (e requestBodySizedError) Error() string {
	return e.err.Error()
}

func (e requestBodySizedError) Unwrap() error {
	return e.err
}

func (e requestBodySizedError) RequestBodyBytes() int {
	return e.requestBodyBytes
}

func WithRequestBodyBytes(err error, requestBodyBytes int) error {
	if err == nil || requestBodyBytes <= 0 {
		return err
	}
	var sized interface{ RequestBodyBytes() int }
	if errors.As(err, &sized) && sized.RequestBodyBytes() > 0 {
		return err
	}
	return requestBodySizedError{
		err:              err,
		requestBodyBytes: requestBodyBytes,
	}
}

func RequestBodyBytesFromError(err error) (int, bool) {
	if err == nil {
		return 0, false
	}
	var sized interface{ RequestBodyBytes() int }
	if !errors.As(err, &sized) {
		return 0, false
	}
	requestBodyBytes := sized.RequestBodyBytes()
	if requestBodyBytes <= 0 {
		return 0, false
	}
	return requestBodyBytes, true
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
