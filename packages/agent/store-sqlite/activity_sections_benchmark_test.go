package storesqlite

import (
	"context"
	"fmt"
	"testing"
)

// BenchmarkStoreListSessionSectionsLargeRemovedProjectHistory measures the
// same 100k-session/200k-turn workspace at several requested-section hit
// densities. It guards both sparse rails dominated by removed projects and
// dense current sections with substantial retained history.
func BenchmarkStoreListSessionSectionsLargeRemovedProjectHistory(b *testing.B) {
	store := openTestStore(b, testOptions(&staticProjectPaths{}))
	requestedSections := []string{PinnedSessionPageKey}
	for index := range 5 {
		requestedSections = append(requestedSections, RailSectionKeyForProject(fmt.Sprintf("/workspace/current/%d", index)))
	}
	requestedSections = append(requestedSections, RailSectionKeyConversations)
	seedLargeRemovedProjectHistory(b, store)

	for _, fixture := range []struct {
		name         string
		matchedCount int
	}{
		{name: "density_0_1_percent", matchedCount: 100},
		{name: "density_10_percent", matchedCount: 10_000},
		{name: "density_50_percent", matchedCount: 50_000},
		{name: "density_100_percent", matchedCount: 100_000},
	} {
		configureRequestedSectionDensity(b, store, requestedSections, fixture.matchedCount)
		input := ListSessionSectionsInput{
			WorkspaceID:     "ws-large-history",
			SectionKeys:     requestedSections,
			AgentTargetID:   testTargetIDCodex,
			LimitPerSection: 5,
		}
		assertBatchMatchesSerialPages(b, store, input)

		b.Run(fixture.name, func(b *testing.B) {
			b.Run("batched_requested_sections", func(b *testing.B) {
				b.ReportAllocs()
				for range b.N {
					if _, ok, err := store.ListSessionSections(context.Background(), input); err != nil || !ok {
						b.Fatalf("ListSessionSections() ok=%v error=%v", ok, err)
					}
				}
			})
			b.Run("serial_reference", func(b *testing.B) {
				b.ReportAllocs()
				for range b.N {
					for _, sectionKey := range requestedSections {
						if _, ok, err := store.ListSessionSection(context.Background(), ListSessionSectionInput{
							WorkspaceID:   input.WorkspaceID,
							SectionKey:    sectionKey,
							AgentTargetID: input.AgentTargetID,
							Limit:         input.LimitPerSection,
						}); err != nil || !ok {
							b.Fatalf("ListSessionSection(%q) ok=%v error=%v", sectionKey, ok, err)
						}
					}
				}
			})
		})
	}

	configureRequestedSectionDensity(b, store, requestedSections, 100_000)
	configureTargetDensity(b, store, 10)
	targetInput := ListSessionSectionsInput{
		WorkspaceID:     "ws-large-history",
		SectionKeys:     requestedSections,
		AgentTargetID:   testTargetIDCodex,
		LimitPerSection: 5,
	}
	assertBatchMatchesSerialPages(b, store, targetInput)
	b.Run("target_density_10_percent", func(b *testing.B) {
		b.Run("batched_requested_sections", func(b *testing.B) {
			b.ReportAllocs()
			for range b.N {
				if _, ok, err := store.ListSessionSections(context.Background(), targetInput); err != nil || !ok {
					b.Fatalf("ListSessionSections() ok=%v error=%v", ok, err)
				}
			}
		})
		b.Run("serial_reference", func(b *testing.B) {
			b.ReportAllocs()
			for range b.N {
				for _, sectionKey := range requestedSections {
					if _, ok, err := store.ListSessionSection(context.Background(), ListSessionSectionInput{
						WorkspaceID:   targetInput.WorkspaceID,
						SectionKey:    sectionKey,
						AgentTargetID: targetInput.AgentTargetID,
						Limit:         targetInput.LimitPerSection,
					}); err != nil || !ok {
						b.Fatalf("ListSessionSection(%q) ok=%v error=%v", sectionKey, ok, err)
					}
				}
			}
		})
	})
}

func assertBatchMatchesSerialPages(b *testing.B, store *Store, input ListSessionSectionsInput) {
	b.Helper()
	batchPage, ok, err := store.ListSessionSections(context.Background(), input)
	if err != nil || !ok {
		b.Fatalf("ListSessionSections() ok=%v error=%v", ok, err)
	}
	batchPages := make(map[string]SessionSectionPage, len(batchPage.Sections))
	for _, page := range batchPage.Sections {
		batchPages[page.SectionKey] = page
	}
	for _, sectionKey := range input.SectionKeys {
		serialPage, ok, err := store.ListSessionSection(context.Background(), ListSessionSectionInput{
			WorkspaceID:   input.WorkspaceID,
			SectionKey:    sectionKey,
			AgentTargetID: input.AgentTargetID,
			Limit:         input.LimitPerSection,
		})
		if err != nil || !ok {
			b.Fatalf("ListSessionSection(%q) ok=%v error=%v", sectionKey, ok, err)
		}
		batchPage := batchPages[sectionKey]
		if len(batchPage.Sessions) != len(serialPage.Sessions) ||
			batchPage.TotalCount != serialPage.TotalCount ||
			batchPage.HasMore != serialPage.HasMore ||
			batchPage.NextCursor != serialPage.NextCursor {
			b.Fatalf("batch page %q = %#v, serial = %#v", sectionKey, batchPage, serialPage)
		}
		for index := range batchPage.Sessions {
			if batchPage.Sessions[index].ID != serialPage.Sessions[index].ID {
				b.Fatalf("batch page %q session %d = %q, serial = %q", sectionKey, index, batchPage.Sessions[index].ID, serialPage.Sessions[index].ID)
			}
		}
	}
}

func seedLargeRemovedProjectHistory(b *testing.B, store *Store) {
	b.Helper()
	const sessionCount = 100_000
	tx, err := store.db.BeginTx(context.Background(), nil)
	if err != nil {
		b.Fatalf("BeginTx() error = %v", err)
	}
	defer func() { _ = tx.Rollback() }()
	sessionStatement, err := tx.Prepare(`
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, agent_target_id, provider,
  session_metadata_json, internal_runtime_context_json, cwd,
  rail_section_kind, rail_project_path, rail_section_key,
  pinned_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, 'codex', '{"visible":true,"imported":false,"capabilities":[]}', '{}', ?, ?, ?, ?, ?, ?, ?)
`)
	if err != nil {
		b.Fatalf("prepare session insert error = %v", err)
	}
	defer sessionStatement.Close()
	turnStatement, err := tx.Prepare(`
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, 'settled', 'completed', ?, ?, ?, ?)
`)
	if err != nil {
		b.Fatalf("prepare turn insert error = %v", err)
	}
	defer turnStatement.Close()

	for index := range sessionCount {
		sessionID := fmt.Sprintf("session-%06d", index)
		sectionKey := fmt.Sprintf("project:/workspace/removed/%05d", index%10_000)
		projectPath := fmt.Sprintf("/workspace/removed/%05d", index%10_000)
		createdAt := int64(index + 1)
		if _, err := sessionStatement.Exec(
			"ws-large-history",
			sessionID,
			testTargetIDCodex,
			projectPath,
			"project",
			projectPath,
			sectionKey,
			0,
			createdAt,
			createdAt,
		); err != nil {
			b.Fatalf("insert session %d error = %v", index, err)
		}
		for turnIndex := range 2 {
			turnTime := createdAt*10 + int64(turnIndex)
			if _, err := turnStatement.Exec(
				"ws-large-history",
				sessionID,
				fmt.Sprintf("turn-%d", turnIndex),
				turnTime,
				turnTime,
				turnTime,
				turnTime,
			); err != nil {
				b.Fatalf("insert turn %d/%d error = %v", index, turnIndex, err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		b.Fatalf("Commit() error = %v", err)
	}
}

func configureRequestedSectionDensity(
	b *testing.B,
	store *Store,
	requestedSections []string,
	matchedCount int,
) {
	b.Helper()
	if len(requestedSections) != 7 {
		b.Fatalf("requested sections = %d, want pinned + five projects + Chats", len(requestedSections))
	}
	tx, err := store.db.BeginTx(context.Background(), nil)
	if err != nil {
		b.Fatalf("BeginTx() error = %v", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(`
UPDATE workspace_agent_sessions
SET rail_section_key = printf('project:/workspace/removed/%05d', (rowid - 1) % 10000),
    pinned_at_unix_ms = 0
WHERE workspace_id = 'ws-large-history'
`); err != nil {
		b.Fatalf("reset removed-project history error = %v", err)
	}
	if _, err := tx.Exec(`
UPDATE workspace_agent_sessions
SET rail_section_key = CASE ((rowid - 1) % 7)
      WHEN 1 THEN ?
      WHEN 2 THEN ?
      WHEN 3 THEN ?
      WHEN 4 THEN ?
      WHEN 5 THEN ?
      WHEN 6 THEN ?
      ELSE rail_section_key
    END,
    pinned_at_unix_ms = CASE
      WHEN ((rowid - 1) % 7) = 0 THEN 200000 + rowid
      ELSE 0
    END
WHERE workspace_id = 'ws-large-history'
  AND rowid <= ?
`,
		requestedSections[1],
		requestedSections[2],
		requestedSections[3],
		requestedSections[4],
		requestedSections[5],
		requestedSections[6],
		matchedCount,
	); err != nil {
		b.Fatalf("configure requested-section density error = %v", err)
	}
	if err := tx.Commit(); err != nil {
		b.Fatalf("Commit() error = %v", err)
	}
}

func configureTargetDensity(b *testing.B, store *Store, codexPercent int) {
	b.Helper()
	if codexPercent <= 0 || codexPercent >= 100 || 100%codexPercent != 0 {
		b.Fatalf("codex target percent = %d, want a positive divisor of 100", codexPercent)
	}
	if _, err := store.db.Exec(`
UPDATE workspace_agent_sessions
SET agent_target_id = CASE
  WHEN ((rowid - 1) % ?) = 0 THEN ?
  ELSE ?
END
WHERE workspace_id = 'ws-large-history'
`, 100/codexPercent, testTargetIDCodex, testTargetIDClaude); err != nil {
		b.Fatalf("configure target density error = %v", err)
	}
}
