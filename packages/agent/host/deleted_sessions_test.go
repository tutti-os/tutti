package agenthost

import (
	"context"
	"reflect"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type deletedSessionStoreStub struct {
	listInput    storesqlite.ListDeletedSessionsInput
	restoreInput storesqlite.RestoreDeletedSessionInput
	purgeInput   storesqlite.PurgeDeletedSessionTreesInput
	page         storesqlite.DeletedSessionPage
	restore      storesqlite.RestoreDeletedSessionResult
	purge        storesqlite.PurgeDeletedSessionTreesResult
}

func (s *deletedSessionStoreStub) ListDeletedSessions(_ context.Context, input storesqlite.ListDeletedSessionsInput) (storesqlite.DeletedSessionPage, error) {
	s.listInput = input
	return s.page, nil
}

func (s *deletedSessionStoreStub) RestoreDeletedSession(_ context.Context, input storesqlite.RestoreDeletedSessionInput) (storesqlite.RestoreDeletedSessionResult, error) {
	s.restoreInput = input
	return s.restore, nil
}

func (s *deletedSessionStoreStub) PurgeDeletedSessionTrees(_ context.Context, input storesqlite.PurgeDeletedSessionTreesInput) (storesqlite.PurgeDeletedSessionTreesResult, error) {
	s.purgeInput = input
	return s.purge, nil
}

func TestDeletedSessionHostSurfaceDelegatesWithoutStartingRuntime(t *testing.T) {
	railSectionKey := storesqlite.RailSectionKeyConversations
	store := &deletedSessionStoreStub{
		page: storesqlite.DeletedSessionPage{
			WorkspaceID: "workspace-1",
			Sessions: []storesqlite.DeletedSessionSummary{{
				AgentSessionID: "root", RailSectionKey: railSectionKey, Restorable: true, UpdatedAtUnixMS: 30,
			}},
			RailSections: []storesqlite.DeletedSessionRailSection{{
				RailSectionKey: "project:/project", ProjectPath: "/project",
			}}, TotalCount: 1, WorkspaceTotalCount: 2,
		},
		restore: storesqlite.RestoreDeletedSessionResult{Restored: true, RestoredSessionIDs: []string{"root", "child"}},
		purge: storesqlite.PurgeDeletedSessionTreesResult{
			PurgedRootSessionIDs: []string{"root"}, PurgedSessionIDs: []string{"child", "root"},
			RemovedSessions: 2, RemovedMessages: 3, PayloadBytes: 64,
		},
	}
	host := New(Config{DeletedSessions: store})
	page, err := host.ListDeletedSessions(t.Context(), ListDeletedSessionsInput{
		WorkspaceID: " workspace-1 ", SearchQuery: "root", RailSectionKey: &railSectionKey,
		CursorUpdatedAtUnixMS: 40, CursorAgentSessionID: "cursor", Limit: 10,
	})
	if err != nil || len(page.Sessions) != 1 || page.TotalCount != 1 || page.WorkspaceTotalCount != 2 {
		t.Fatalf("ListDeletedSessions()=%#v err=%v", page, err)
	}
	if store.listInput.WorkspaceID != "workspace-1" || store.listInput.RailSectionKey == nil || *store.listInput.RailSectionKey != storesqlite.RailSectionKeyConversations {
		t.Fatalf("list input=%#v", store.listInput)
	}
	restored, err := host.RestoreDeletedSession(t.Context(), RestoreDeletedSessionInput{WorkspaceID: "workspace-1", AgentSessionID: "root"})
	if err != nil || !restored.Restored || !reflect.DeepEqual(restored.RestoredSessionIDs, []string{"root", "child"}) {
		t.Fatalf("RestoreDeletedSession()=%#v err=%v", restored, err)
	}
	purged, err := host.PurgeDeletedSessionTrees(t.Context(), PurgeDeletedSessionTreesInput{
		WorkspaceID: "workspace-1", RootSessionIDs: []string{"root", "root"},
	})
	if err != nil || purged.RemovedSessions != 2 || purged.PayloadBytes != 64 ||
		!reflect.DeepEqual(store.purgeInput.RootSessionIDs, []string{"root"}) {
		t.Fatalf("PurgeDeletedSessionTrees()=%#v input=%#v err=%v", purged, store.purgeInput, err)
	}
}
