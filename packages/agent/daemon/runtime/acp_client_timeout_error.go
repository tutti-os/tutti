package agentruntime

import (
	"context"
	"fmt"
	"time"
)

type acpCallTimeoutError struct {
	Method  string
	Timeout time.Duration
}

func (e *acpCallTimeoutError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("acp %s timed out after %s", e.Method, e.Timeout)
}

func (*acpCallTimeoutError) Unwrap() error {
	return context.DeadlineExceeded
}
