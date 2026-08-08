package conformance

import (
	"context"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

func runLosslessDeletedSessionRestore(ctx context.Context, driver DeletedSessionLifecycleDriver) error {
	ref := agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-restore"}
	if err := driver.Reset(ctx, Fixture{Session: &SessionSeed{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		Provider: "codex", ProviderSessionID: "provider-session-restore",
		Title: "Recoverable", Cwd: "/workspace", Live: false,
	}}); err != nil {
		return err
	}
	before := driver.Metrics()
	deleted, err := driver.DeleteSession(ctx, ref)
	if err != nil {
		return err
	}
	if !deleted.Deleted || !deleted.CanonicalRemoved {
		return fmt.Errorf("delete result = %#v, want canonical tombstone", deleted)
	}
	page, err := driver.ListDeletedSessions(ctx, agenthost.ListDeletedSessionsInput{WorkspaceID: ref.WorkspaceID})
	if err != nil {
		return err
	}
	if len(page.Sessions) != 1 || page.Sessions[0].AgentSessionID != ref.AgentSessionID || !page.Sessions[0].Restorable {
		return fmt.Errorf("deleted session page = %#v, want one restorable component", page)
	}
	restored, err := driver.RestoreDeletedSession(ctx, agenthost.RestoreDeletedSessionInput(ref))
	if err != nil {
		return err
	}
	if !restored.Restored || len(restored.RestoredSessionIDs) != 1 || restored.RestoredSessionIDs[0] != ref.AgentSessionID {
		return fmt.Errorf("restore result = %#v", restored)
	}
	after := driver.Metrics()
	if after.StartCalls != before.StartCalls || after.ResumeCalls != before.ResumeCalls {
		return fmt.Errorf("restore started provider work: before=%#v after=%#v", before, after)
	}
	canonical, err := driver.GetCanonicalSession(ctx, ref)
	if err != nil {
		return err
	}
	if canonical.SessionID != ref.AgentSessionID || canonical.ProviderSessionID != "provider-session-restore" {
		return fmt.Errorf("restored canonical session = %#v", canonical)
	}
	return nil
}
