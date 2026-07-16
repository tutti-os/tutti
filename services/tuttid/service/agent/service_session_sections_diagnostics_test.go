package agent

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestSessionSectionsDiagnosticsSuppressFastAndCanceledRequests(t *testing.T) {
	var output bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	diagnostics := &sessionSectionsDiagnostics{}

	logSessionSectionsDiagnostics(
		context.Background(),
		"ws-1",
		"local:codex",
		5,
		sessionSectionsSlowLogThreshold-time.Millisecond,
		diagnostics,
		nil,
	)
	logSessionSectionsDiagnostics(
		context.Background(),
		"ws-1",
		"local:codex",
		5,
		time.Second,
		diagnostics,
		context.Canceled,
	)

	if output.Len() != 0 {
		t.Fatalf("suppressed diagnostics wrote %q", output.String())
	}
}

func TestSessionSectionsDiagnosticsRecordSlowAndFailedRequests(t *testing.T) {
	var output bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })
	diagnostics := &sessionSectionsDiagnostics{
		currentProjectCount:     2,
		hydrateDuration:         30 * time.Millisecond,
		nonEmptyProjectCount:    1,
		projectDuration:         10 * time.Millisecond,
		railVisibleSessionCount: 42,
		returnedSessionCount:    12,
		sectionCount:            4,
		storeDuration:           220 * time.Millisecond,
	}

	logSessionSectionsDiagnostics(
		context.Background(),
		"ws-1",
		"local:codex",
		5,
		300*time.Millisecond,
		diagnostics,
		nil,
	)
	diagnostics.failureStage = "store"
	logSessionSectionsDiagnostics(
		context.Background(),
		"ws-1",
		"local:codex",
		5,
		40*time.Millisecond,
		diagnostics,
		errors.New("store unavailable"),
	)

	logs := output.String()
	for _, expected := range []string{
		"workspace.agent_session.sections.list_slow",
		"workspace.agent_session.sections.list_failed",
		"agent_target_id=local:codex",
		"duration_ms=300",
		"projects_ms=10",
		"store_ms=220",
		"hydrate_ms=30",
		"current_project_count=2",
		"non_empty_project_count=1",
		"rail_visible_session_count=42",
		"returned_session_count=12",
		"section_count=4",
		"failure_stage=store",
	} {
		if !strings.Contains(logs, expected) {
			t.Fatalf("diagnostics missing %q in:\n%s", expected, logs)
		}
	}
}
