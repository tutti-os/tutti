package agent

import (
	"context"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
)

type deletedSessionAdapterStoreStub struct {
	listInput    agentactivitybiz.ListDeletedSessionsInput
	restoreInput agentactivitybiz.RestoreDeletedSessionInput
	purgeInput   agentactivitybiz.PurgeDeletedSessionTreesInput
	page         agentactivitybiz.DeletedSessionPage
}

func (s *deletedSessionAdapterStoreStub) ListDeletedSessions(
	_ context.Context,
	input agentactivitybiz.ListDeletedSessionsInput,
) (agentactivitybiz.DeletedSessionPage, error) {
	s.listInput = input
	return s.page, nil
}

func (s *deletedSessionAdapterStoreStub) RestoreDeletedSession(
	_ context.Context,
	input agentactivitybiz.RestoreDeletedSessionInput,
) (agentactivitybiz.RestoreDeletedSessionResult, error) {
	s.restoreInput = input
	return agentactivitybiz.RestoreDeletedSessionResult{}, nil
}

func (s *deletedSessionAdapterStoreStub) PurgeDeletedSessionTrees(
	_ context.Context,
	input agentactivitybiz.PurgeDeletedSessionTreesInput,
) (agentactivitybiz.PurgeDeletedSessionTreesResult, error) {
	s.purgeInput = input
	return agentactivitybiz.PurgeDeletedSessionTreesResult{}, nil
}

func TestListDeletedSessionsMapsOpaqueCursorAndProjectOptions(t *testing.T) {
	currentSectionKey := agentactivitybiz.RailSectionKeyForProject("/current/project")
	removedSectionKey := agentactivitybiz.RailSectionKeyForProject("/removed/repo")
	store := &deletedSessionAdapterStoreStub{page: agentactivitybiz.DeletedSessionPage{
		Sessions: []agentactivitybiz.DeletedSessionSummary{{
			AgentSessionID: "root-1", Title: "Deleted", RailSectionKey: currentSectionKey,
			ProjectPath:     "/stale/original",
			UpdatedAtUnixMS: 200, DeletedAtUnixMS: 300, Restorable: true,
		}},
		RailSections: []agentactivitybiz.DeletedSessionRailSection{
			{RailSectionKey: currentSectionKey, ProjectPath: "/stale/original"},
			{RailSectionKey: removedSectionKey, ProjectPath: "/removed/repo"},
		},
		TotalCount:          1,
		WorkspaceTotalCount: 2,
		HasMore:             true,
		NextCursor:          "100|root-2",
	}}
	service := NewService(newFakeRuntime())
	service.SetApplicationHost(agenthost.New(agenthost.Config{DeletedSessions: store}))
	service.UserProjectReader = fakeUserProjectReader{projects: []userprojectbiz.Project{{
		Path: "/current/project", Label: "Current project", SectionKey: currentSectionKey,
	}}}
	unscoped := agentactivitybiz.RailSectionKeyConversations

	page, err := service.ListDeletedSessions(context.Background(), " workspace-1 ", ListDeletedSessionsInput{
		SearchQuery: " deleted ", RailSectionKey: &unscoped, Cursor: "200|root-z", Limit: 25,
	})
	if err != nil {
		t.Fatal(err)
	}
	if store.listInput.WorkspaceID != "workspace-1" || store.listInput.SearchQuery != "deleted" ||
		store.listInput.CursorUpdatedAtUnixMS != 200 || store.listInput.CursorAgentSessionID != "root-z" ||
		store.listInput.RailSectionKey == nil || *store.listInput.RailSectionKey != agentactivitybiz.RailSectionKeyConversations || store.listInput.Limit != 25 {
		t.Fatalf("host input = %#v", store.listInput)
	}
	if len(page.Sessions) != 1 || page.TotalCount != 1 || page.WorkspaceTotalCount != 2 ||
		!page.HasMore || page.NextCursor != "100|root-2" ||
		page.Sessions[0].RailSectionKey != currentSectionKey {
		t.Fatalf("page = %#v", page)
	}
	if len(page.ProjectOptions) != 2 || !page.ProjectOptions[0].ProjectAvailable ||
		page.ProjectOptions[0].RailSectionKey != currentSectionKey ||
		page.ProjectOptions[0].ProjectLabel != "Current project" ||
		page.ProjectOptions[1].ProjectAvailable || page.ProjectOptions[1].ProjectLabel != "repo" {
		t.Fatalf("project options = %#v", page.ProjectOptions)
	}
}
