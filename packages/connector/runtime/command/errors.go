package command

import (
	"errors"
	"strings"
)

var (
	ErrNotFound           = errors.New("connector command not found")
	ErrInvalidInput       = errors.New("connector command input is invalid")
	ErrServiceUnavailable = errors.New("connector command service is unavailable")
	ErrExecutionFailed    = errors.New("connector command execution failed")
)

type Error struct {
	Kind   error
	Code   string
	Detail string
	Err    error
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	message := strings.TrimSpace(e.Detail)
	if e.Err != nil {
		if message != "" {
			message += ": "
		}
		message += e.Err.Error()
	}
	if message == "" && e.Kind != nil {
		message = e.Kind.Error()
	}
	return message
}

func (e *Error) Unwrap() error {
	if e == nil {
		return nil
	}
	if e.Kind == nil {
		return e.Err
	}
	if e.Err == nil {
		return e.Kind
	}
	return errors.Join(e.Kind, e.Err)
}

func InvalidInput(code, detail string, err error) error {
	return &Error{Kind: ErrInvalidInput, Code: strings.TrimSpace(code), Detail: strings.TrimSpace(detail), Err: err}
}

func ServiceUnavailable(detail string, err error) error {
	return &Error{Kind: ErrServiceUnavailable, Detail: strings.TrimSpace(detail), Err: err}
}

func ExecutionFailed(detail string, err error) error {
	return &Error{Kind: ErrExecutionFailed, Detail: strings.TrimSpace(detail), Err: err}
}

func ErrorCode(err error) string {
	var commandErr *Error
	if errors.As(err, &commandErr) {
		return commandErr.Code
	}
	return ""
}
