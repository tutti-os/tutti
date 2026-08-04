//go:build windows

package workspace

import (
	"errors"
)

func describeTerminalExit(err error) (*int, *string) {
	var exitErr terminalProcessExitError
	if !errors.As(err, &exitErr) {
		return nil, nil
	}

	code := exitErr.code
	if code < 0 {
		return nil, nil
	}
	return &code, nil
}
