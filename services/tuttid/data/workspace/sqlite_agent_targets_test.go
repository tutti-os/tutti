package workspace

import (
	"context"
	"errors"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func TestSQLiteStoreSeedsSystemAgentTargets(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)

	targets, err := store.ListAgentTargets(context.Background())
	if err != nil {
		t.Fatalf("ListAgentTargets() error = %v", err)
	}
	if len(targets) != 2 {
		t.Fatalf("ListAgentTargets() len = %d, want 2", len(targets))
	}
	if targets[0].ID != agenttargetbiz.IDLocalCodex || targets[0].Provider != "codex" {
		t.Fatalf("first target = %#v, want local codex", targets[0])
	}
	if targets[1].ID != agenttargetbiz.IDLocalClaudeCode || targets[1].Provider != "claude-code" {
		t.Fatalf("second target = %#v, want local claude-code", targets[1])
	}
	for _, target := range targets {
		if target.Source != agenttargetbiz.SourceSystem {
			t.Fatalf("target %q source = %q, want system", target.ID, target.Source)
		}
		if !target.Enabled {
			t.Fatalf("target %q enabled = false, want true", target.ID)
		}
		if _, err := agenttargetbiz.CanonicalLaunchRefJSONString(target.Provider, target.LaunchRefJSON); err != nil {
			t.Fatalf("target %q launch ref invalid: %v", target.ID, err)
		}
	}
}

func TestSQLiteStoreListAgentTargetsSkipsInvalidRows(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	now := int64(1700000000000)
	if _, err := store.db.ExecContext(ctx, `
	INSERT INTO agent_targets (
	  id,
	  provider,
	  launch_ref_json,
	  name,
	  icon_key,
	  enabled,
	  source,
	  sort_order,
	  created_at_ms,
	  updated_at_ms
	)
	VALUES ('broken-target', 'codex', '{"type":"local_cli","provider":"claude-code"}', 'Broken Target', NULL, 1, 'user', 5, ?, ?);
	`, now, now); err != nil {
		t.Fatalf("insert invalid agent target fixture: %v", err)
	}

	targets, err := store.ListAgentTargets(ctx)
	if err != nil {
		t.Fatalf("ListAgentTargets() error = %v", err)
	}
	ids := make(map[string]bool, len(targets))
	for _, target := range targets {
		ids[target.ID] = true
	}
	if ids["broken-target"] {
		t.Fatalf("ListAgentTargets() returned invalid target: %#v", targets)
	}
	if !ids[agenttargetbiz.IDLocalCodex] || !ids[agenttargetbiz.IDLocalClaudeCode] {
		t.Fatalf("ListAgentTargets() ids = %#v, want system targets", ids)
	}
}

func TestSQLiteStoreSeedReconcilesLegacySystemAgentTargetIDs(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	now := int64(1700000000000)
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspaces (id, name, created_at_unix_ms, updated_at_unix_ms)
VALUES ('ws-legacy-targets', 'Legacy Targets', ?, ?);
`, now, now); err != nil {
		t.Fatalf("insert legacy workspace fixture: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO agent_targets (
  id,
  provider,
  launch_ref_json,
  name,
  icon_key,
  enabled,
  source,
  sort_order,
  created_at_ms,
  updated_at_ms
)
VALUES (?, 'codex', ?, 'Legacy Codex', 'codex', 1, 'system', 10, ?, ?);
`, legacyIDLocalCodex, agenttargetbiz.MustLocalCLILaunchRefJSON("codex"), now, now); err != nil {
		t.Fatalf("insert legacy agent target fixture: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_sessions (
  workspace_id,
  agent_session_id,
  origin,
  agent_target_id,
  provider,
  status,
  created_at_unix_ms,
  updated_at_unix_ms
)
VALUES ('ws-legacy-targets', 'session-1', 'runtime', ?, 'codex', 'ready', ?, ?);
`, legacyIDLocalCodex, now, now); err != nil {
		t.Fatalf("insert legacy agent session fixture: %v", err)
	}

	if err := store.seedSystemAgentTargets(ctx, now+1); err != nil {
		t.Fatalf("seedSystemAgentTargets() error = %v", err)
	}

	if _, err := store.GetAgentTarget(ctx, legacyIDLocalCodex); !errors.Is(err, ErrAgentTargetNotFound) {
		t.Fatalf("GetAgentTarget(legacy) error = %v, want ErrAgentTargetNotFound", err)
	}
	if _, err := store.GetAgentTarget(ctx, agenttargetbiz.IDLocalCodex); err != nil {
		t.Fatalf("GetAgentTarget(current) error = %v", err)
	}
	sessions, ok, err := store.ListSessions(ctx, "ws-legacy-targets")
	if err != nil {
		t.Fatalf("ListSessions() error = %v", err)
	}
	if !ok || len(sessions) != 1 {
		t.Fatalf("ListSessions() ok/len = %v/%d, want true/1", ok, len(sessions))
	}
	if sessions[0].AgentTargetID != agenttargetbiz.IDLocalCodex {
		t.Fatalf("session agent target id = %q, want %s", sessions[0].AgentTargetID, agenttargetbiz.IDLocalCodex)
	}
}

func TestSQLiteStorePutAgentTargetRejectsInvalidLaunchRefs(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name          string
		provider      string
		launchRefJSON string
	}{
		{
			name:          "unknown type",
			provider:      "codex",
			launchRefJSON: `{"type":"agent_profile","provider":"codex"}`,
		},
		{
			name:          "provider mismatch",
			provider:      "codex",
			launchRefJSON: `{"type":"local_cli","provider":"claude-code"}`,
		},
		{
			name:          "config blob",
			provider:      "codex",
			launchRefJSON: `{"type":"local_cli","provider":"codex","model":"gpt-5"}`,
		},
		{
			name:          "prompt config",
			provider:      "codex",
			launchRefJSON: `{"type":"local_cli","provider":"codex","prompt":"always plan"}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			store := openTestSQLiteStore(t)
			_, err := store.PutAgentTarget(context.Background(), agenttargetbiz.Target{
				ID:            "custom",
				Provider:      tc.provider,
				LaunchRefJSON: tc.launchRefJSON,
				Name:          "Custom",
				Enabled:       true,
				Source:        agenttargetbiz.SourceUser,
			})
			if !errors.Is(err, agenttargetbiz.ErrInvalidLaunchRef) {
				t.Fatalf("PutAgentTarget() error = %v, want ErrInvalidLaunchRef", err)
			}
		})
	}
}

func TestSQLiteStorePutAgentTargetCanonicalizesLaunchRef(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	target, err := store.PutAgentTarget(context.Background(), agenttargetbiz.Target{
		ID:            "custom-codex",
		Provider:      " codex ",
		LaunchRefJSON: `{"provider":"codex","type":"local_cli"}`,
		Name:          " Custom Codex ",
		Enabled:       true,
		Source:        agenttargetbiz.SourceUser,
		SortOrder:     30,
	})
	if err != nil {
		t.Fatalf("PutAgentTarget() error = %v", err)
	}
	if target.LaunchRefJSON != `{"type":"local_cli","provider":"codex"}` {
		t.Fatalf("LaunchRefJSON = %q, want canonical local_cli codex", target.LaunchRefJSON)
	}
	if target.Name != "Custom Codex" {
		t.Fatalf("Name = %q, want trimmed Custom Codex", target.Name)
	}
}
