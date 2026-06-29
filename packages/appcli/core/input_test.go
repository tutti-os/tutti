package core

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalizeInputIgnoresUnknownAndCoercesScalars(t *testing.T) {
	input, err := NormalizeInput(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"count":   map[string]any{"type": "integer"},
			"dry-run": map[string]any{"type": "boolean"},
			"name":    map[string]any{"type": "string"},
		},
		"required": []any{"count"},
	}, map[string]any{
		"count":   "2",
		"dry-run": "true",
		"name":    "daily",
		"unknown": "x",
	})
	if err != nil {
		t.Fatalf("NormalizeInput() error = %v", err)
	}
	if input["count"] != int64(2) || input["dry-run"] != true || input["name"] != "daily" {
		t.Fatalf("input = %#v", input)
	}
	if _, ok := input["unknown"]; ok {
		t.Fatalf("unknown input was forwarded: %#v", input)
	}
}

func TestNormalizeInputWithWarningsReportsUnknownInput(t *testing.T) {
	input, warnings, err := NormalizeInputWithWarnings(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"name": map[string]any{"type": "string"},
		},
	}, map[string]any{
		"name":     "daily",
		"schedule": "0 9 * * *",
	})
	if err != nil {
		t.Fatalf("NormalizeInputWithWarnings() error = %v", err)
	}
	if input["name"] != "daily" {
		t.Fatalf("input = %#v", input)
	}
	if len(warnings) != 1 ||
		warnings[0].Code != "unknown_input_ignored" ||
		!strings.Contains(warnings[0].Message, `"schedule"`) {
		t.Fatalf("warnings = %#v", warnings)
	}
}

func TestNormalizeInputRequiresRequiredProperties(t *testing.T) {
	_, err := NormalizeInput(map[string]any{
		"type":       "object",
		"properties": map[string]any{"name": map[string]any{"type": "string"}},
		"required":   []any{"name"},
	}, map[string]any{})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("NormalizeInput() error = %v, want ErrInvalidInput", err)
	}
}
