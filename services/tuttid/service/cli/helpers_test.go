package cli

import (
	"errors"
	"strings"
	"testing"
)

func TestRequiredStringInputReportsMissingKey(t *testing.T) {
	_, err := RequiredStringInput(map[string]any{}, "topic-id")
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
	if !strings.Contains(err.Error(), `required input "topic-id" is missing`) {
		t.Fatalf("err = %q", err.Error())
	}
}

func TestStringInputReportsInvalidKeyType(t *testing.T) {
	_, _, err := StringInput(map[string]any{"session-id": 42}, "session-id")
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
	if !strings.Contains(err.Error(), `invalid input "session-id"`) {
		t.Fatalf("err = %q", err.Error())
	}
}
