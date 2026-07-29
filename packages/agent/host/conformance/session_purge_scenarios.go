package conformance

import (
	"context"
	"fmt"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

func runPurgeDeletedSessions(ctx context.Context, driver Driver) error {
	if err := driver.Reset(ctx, Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-purge", Provider: "codex",
		Cwd: "/workspace", Deleted: true,
	}}); err != nil {
		return err
	}
	result, err := driver.PurgeDeletedSessions(ctx, agenthost.PurgeDeletedSessionsInput{CutoffUnixMS: 100})
	if err != nil {
		return fmt.Errorf("purge deleted sessions: %w", err)
	}
	if len(result.Sessions) != 1 || result.Sessions[0].AgentSessionID != "session-purge" {
		return fmt.Errorf("purge deleted sessions result=%#v", result)
	}
	repeat, err := driver.PurgeDeletedSessions(ctx, agenthost.PurgeDeletedSessionsInput{CutoffUnixMS: 100})
	if err != nil {
		return fmt.Errorf("repeat purge deleted sessions: %w", err)
	}
	if len(repeat.Sessions) != 0 || repeat.RemovedMessages != 0 {
		return fmt.Errorf("repeat purge deleted sessions result=%#v", repeat)
	}

	if err := driver.Reset(ctx, Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-too-new", Provider: "codex",
		Cwd: "/workspace", Deleted: true, DeletedAtUnixMS: 200,
	}}); err != nil {
		return err
	}
	tooNew, err := driver.PurgeDeletedSessions(ctx, agenthost.PurgeDeletedSessionsInput{CutoffUnixMS: 199})
	if err != nil {
		return fmt.Errorf("purge sessions before tombstone cutoff: %w", err)
	}
	if len(tooNew.Sessions) != 0 {
		return fmt.Errorf("purge sessions before tombstone cutoff result=%#v", tooNew)
	}
	atCutoff, err := driver.PurgeDeletedSessions(ctx, agenthost.PurgeDeletedSessionsInput{CutoffUnixMS: 200})
	if err != nil {
		return fmt.Errorf("purge sessions at tombstone cutoff: %w", err)
	}
	if len(atCutoff.Sessions) != 1 || atCutoff.Sessions[0].AgentSessionID != "session-too-new" {
		return fmt.Errorf("purge sessions at tombstone cutoff result=%#v", atCutoff)
	}

	if err := driver.Reset(ctx, Fixture{Session: &SessionSeed{
		WorkspaceID: "workspace-1", AgentSessionID: "session-live", Provider: "codex",
		Cwd: "/workspace",
	}}); err != nil {
		return err
	}
	liveResult, err := driver.PurgeDeletedSessions(ctx, agenthost.PurgeDeletedSessionsInput{CutoffUnixMS: 1_000})
	if err != nil {
		return fmt.Errorf("purge with live session: %w", err)
	}
	if len(liveResult.Sessions) != 0 {
		return fmt.Errorf("purge with live session result=%#v", liveResult)
	}
	live, err := driver.GetSession(ctx, agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-live"})
	if err != nil || live.SessionID != "session-live" {
		return fmt.Errorf("live session after purge=%#v, error=%v", live, err)
	}

	if err := driver.Reset(ctx, Fixture{
		Session: &SessionSeed{
			WorkspaceID: "workspace-1", AgentSessionID: "tree-root", Provider: "codex",
			Cwd: "/workspace", Deleted: true, DeletedAtUnixMS: 100,
		},
		AdditionalSessions: []SessionSeed{{
			WorkspaceID: "workspace-1", AgentSessionID: "tree-restored-child", Provider: "codex",
			Cwd: "/workspace", ParentAgentSessionID: "tree-root",
		}},
	}); err != nil {
		return err
	}
	restoredTree, err := driver.PurgeDeletedSessions(ctx, agenthost.PurgeDeletedSessionsInput{CutoffUnixMS: 100})
	if err != nil {
		return fmt.Errorf("purge tree with restored child: %w", err)
	}
	if len(restoredTree.Sessions) != 0 {
		return fmt.Errorf("purge tree with restored child result=%#v", restoredTree)
	}

	if err := driver.Reset(ctx, Fixture{
		Session: &SessionSeed{
			WorkspaceID: "workspace-1", AgentSessionID: "tree-root", Provider: "codex",
			Cwd: "/workspace", Deleted: true, DeletedAtUnixMS: 100,
		},
		AdditionalSessions: []SessionSeed{{
			WorkspaceID: "workspace-1", AgentSessionID: "tree-child", Provider: "codex",
			Cwd: "/workspace", ParentAgentSessionID: "tree-root", Deleted: true, DeletedAtUnixMS: 100,
		}},
	}); err != nil {
		return err
	}
	leaf, err := driver.PurgeDeletedSessions(ctx, agenthost.PurgeDeletedSessionsInput{CutoffUnixMS: 100})
	if err != nil {
		return fmt.Errorf("purge tombstoned tree leaf: %w", err)
	}
	if len(leaf.Sessions) != 1 || leaf.Sessions[0].AgentSessionID != "tree-child" || !leaf.HasMore {
		return fmt.Errorf("purge tombstoned tree leaf result=%#v", leaf)
	}
	root, err := driver.PurgeDeletedSessions(ctx, agenthost.PurgeDeletedSessionsInput{CutoffUnixMS: 100})
	if err != nil {
		return fmt.Errorf("purge tombstoned tree root: %w", err)
	}
	if len(root.Sessions) != 1 || root.Sessions[0].AgentSessionID != "tree-root" || root.HasMore {
		return fmt.Errorf("purge tombstoned tree root result=%#v", root)
	}
	return nil
}
