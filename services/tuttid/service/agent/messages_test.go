package agent

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
)

func TestServiceListsSessionMessages(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	lastLimit := 0
	lastTurnID := ""
	service.MessageReader = fakeMessageReader{
		lastLimit:  &lastLimit,
		lastTurnID: &lastTurnID,
		page: SessionMessagesPage{
			AgentSessionID: "session-1",
			Messages: []SessionMessage{
				{
					AgentSessionID: "session-1",
					MessageID:      "msg-1",
					Payload:        map[string]any{"content": "done"},
					Version:        3,
				},
			},
			LatestVersion: 3,
			HasMore:       false,
		},
	}

	page, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"session-1",
		ListMessagesInput{TurnID: "turn-1", AfterVersion: 1, Limit: 20},
	)
	if err != nil {
		t.Fatalf("ListMessages returned error: %v", err)
	}
	if page.AgentSessionID != "session-1" {
		t.Fatalf("agent session id = %q, want session-1", page.AgentSessionID)
	}
	if len(page.Messages) != 1 {
		t.Fatalf("len(page.Messages) = %d, want 1", len(page.Messages))
	}
	if lastTurnID != "turn-1" {
		t.Fatalf("turn id = %q, want turn-1", lastTurnID)
	}
	page.Messages[0].Payload["content"] = "mutated"
	nextPage, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"session-1",
		ListMessagesInput{},
	)
	if err != nil {
		t.Fatalf("ListMessages second read returned error: %v", err)
	}
	if got := nextPage.Messages[0].Payload["content"]; got != "done" {
		t.Fatalf("payload content = %#v, want done", got)
	}
	if lastLimit != defaultListMessagesLimit {
		t.Fatalf("default limit = %d, want %d", lastLimit, defaultListMessagesLimit)
	}
}

func TestServiceListMessagesReturnsEmptyPageForLiveSessionWithoutProjection(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:live-session"] = ProviderRuntimeSession{
		ID:          "live-session",
		WorkspaceID: "ws-1",
		Provider:    "codex",
	}
	service := newIsolatedAgentService(runtime)

	page, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"live-session",
		ListMessagesInput{AfterVersion: 7, Limit: 20},
	)
	if err != nil {
		t.Fatalf("ListMessages returned error: %v", err)
	}
	if page.AgentSessionID != "live-session" {
		t.Fatalf("agent session id = %q, want live-session", page.AgentSessionID)
	}
	if len(page.Messages) != 0 || page.LatestVersion != 7 || page.HasMore {
		t.Fatalf("page = %#v, want empty page preserving after version", page)
	}
}

func TestServiceListMessagesReturnsEmptyPageForPersistedSessionWithoutProjectionMessages(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:persisted-session": {
				ID:          "persisted-session",
				WorkspaceID: "ws-1",
				Provider:    "codex",
			},
		},
	}
	service.MessageReader = fakeMessageReader{}

	page, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"persisted-session",
		ListMessagesInput{Order: agentactivitybiz.MessageOrderDesc, Limit: 20},
	)
	if err != nil {
		t.Fatalf("ListMessages returned error: %v", err)
	}
	if page.AgentSessionID != "persisted-session" {
		t.Fatalf("agent session id = %q, want persisted-session", page.AgentSessionID)
	}
	if len(page.Messages) != 0 || page.LatestVersion != 0 || page.HasMore {
		t.Fatalf("page = %#v, want empty desc page", page)
	}
}

func TestServiceListMessagesReturnsNotFoundForUnknownSession(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	service.MessageReader = fakeMessageReader{}

	if _, err := service.ListMessages(
		context.Background(),
		"ws-1",
		"missing-session",
		ListMessagesInput{},
	); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("ListMessages error = %v, want ErrSessionNotFound", err)
	}
}

func TestServiceFallsBackToPersistedSessions(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:                "session-1",
				WorkspaceID:       "ws-1",
				Provider:          "codex",
				Metadata:          agentactivitybiz.SessionMetadata{Visible: true},
				ProviderSessionID: "provider-session-1",
				ActiveTurnID:      "turn-1",
				Title:             "Persisted session",
				CreatedAtUnixMS:   1000,
				UpdatedAtUnixMS:   2000,
			},
		},
	}

	list, err := service.List(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("List returned error: %v", err)
	}
	if len(list) != 1 || list[0].ID != "session-1" {
		t.Fatalf("persisted list = %#v", list)
	}

	got, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get returned error: %v", err)
	}
	if got.ID != "session-1" {
		t.Fatalf("persisted get id = %q", got.ID)
	}
	if !got.Resumable {
		t.Fatal("persisted session resumable = false, want true")
	}
}

type recordingSessionPageReader struct {
	fakeSessionReader
	inputs []agentactivitybiz.ListSessionsPageInput
	pages  map[string]PersistedSessionListPage
	err    error
}

func (r *recordingSessionPageReader) ListSessionsPage(
	_ context.Context,
	input agentactivitybiz.ListSessionsPageInput,
) (PersistedSessionListPage, bool, error) {
	r.inputs = append(r.inputs, input)
	if r.err != nil {
		return PersistedSessionListPage{}, false, r.err
	}
	return r.pages[input.CursorSessionID], true, nil
}

func TestServiceListPageDelegatesSearchTargetAndCursorToCanonicalReader(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-newer"] = ProviderRuntimeSession{
		ID:              "session-newer",
		WorkspaceID:     "ws-1",
		AgentTargetID:   "local:codex",
		Provider:        "codex",
		Cwd:             "/workspace/newer",
		Status:          "working",
		Visible:         true,
		Title:           "Mention newer",
		CreatedAtUnixMS: time.UnixMilli(1000).UnixMilli(),
		UpdatedAtUnixMS: time.UnixMilli(4000).UnixMilli(),
	}

	service := newIsolatedAgentService(runtime)
	reader := &recordingSessionPageReader{pages: map[string]PersistedSessionListPage{
		"": {
			Sessions: []PersistedSession{{
				ID: "session-newer", WorkspaceID: "ws-1", AgentTargetID: "local:codex",
				Provider: "codex", RailSectionKey: "conversations",
				Metadata: agentactivitybiz.SessionMetadata{Visible: true},
			}},
			HasMore: true, NextCursor: "4000|session-newer",
		},
		"session-newer": {
			Sessions: []PersistedSession{{
				ID: "session-older", WorkspaceID: "ws-1", AgentTargetID: "local:codex",
				Provider: "codex", RailSectionKey: "conversations",
				Metadata: agentactivitybiz.SessionMetadata{Visible: true},
			}},
		},
	}}
	service.SessionReader = reader
	page, err := service.ListPage(context.Background(), "ws-1", ListSessionsInput{
		AgentTargetID: "local:codex",
		SearchQuery:   "mention",
		Limit:         1,
	})
	if err != nil {
		t.Fatalf("ListPage returned error: %v", err)
	}
	if len(page.Sessions) != 1 {
		t.Fatalf("len(page.Sessions) = %d, want 1", len(page.Sessions))
	}
	if page.Sessions[0].ID != "session-newer" || !page.HasMore || page.NextCursor == "" {
		t.Fatalf("first page = %#v, want newer session with next cursor", page)
	}

	nextPage, err := service.ListPage(context.Background(), "ws-1", ListSessionsInput{
		AgentTargetID: "local:codex",
		Cursor:        page.NextCursor,
		SearchQuery:   "mention",
		Limit:         1,
	})
	if err != nil {
		t.Fatalf("ListPage(next) returned error: %v", err)
	}
	if len(nextPage.Sessions) != 1 || nextPage.Sessions[0].ID != "session-older" || nextPage.HasMore {
		t.Fatalf("next page = %#v, want final older session", nextPage)
	}
	if len(reader.inputs) != 2 || reader.inputs[0].AgentTargetID != "local:codex" || reader.inputs[0].SearchQuery != "mention" || reader.inputs[0].Limit != 1 {
		t.Fatalf("canonical reader inputs = %#v", reader.inputs)
	}
	if reader.inputs[1].CursorSortTimeUnixMS != 4000 || reader.inputs[1].CursorSessionID != "session-newer" {
		t.Fatalf("canonical reader cursor = %#v", reader.inputs[1])
	}
}

func TestServiceListSessionSectionsUsesCurrentProjectsAndConversations(t *testing.T) {
	reader := &fakeSectionReader{
		pages: map[string]agentactivitybiz.SessionSectionPage{
			"project:/workspace/project": {
				SectionKey: "project:/workspace/project",
				Sessions: []agentactivitybiz.Session{{
					ID:              "project-session",
					WorkspaceID:     "ws-1",
					Provider:        "codex",
					Cwd:             "/workspace/project",
					CreatedAtUnixMS: 1000,
					UpdatedAtUnixMS: 5000,
				}},
				HasMore:    true,
				TotalCount: 7,
				NextCursor: "5000|project-session",
			},
			"conversations": {
				SectionKey: "conversations",
				Sessions: []agentactivitybiz.Session{{
					ID:              "chat-session",
					WorkspaceID:     "ws-1",
					Provider:        "codex",
					Cwd:             "/scratch/session",
					CreatedAtUnixMS: 1000,
					UpdatedAtUnixMS: 4000,
				}},
			},
			agentactivitybiz.PinnedSessionPageKey: {
				SectionKey: agentactivitybiz.PinnedSessionPageKey,
				Sessions: []agentactivitybiz.Session{{
					ID:              "pinned-session",
					WorkspaceID:     "ws-1",
					Provider:        "codex",
					PinnedAtUnixMS:  6000,
					CreatedAtUnixMS: 1000,
					UpdatedAtUnixMS: 3000,
				}},
				HasMore:    true,
				TotalCount: 3,
				NextCursor: "6000|pinned-session",
			},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = reader
	latestTurnCalls := 0
	activeTurnCalls := 0
	pendingInteractionCalls := 0
	latestInteractionCalls := 0
	service.TurnStore = failingTurnStore{
		latestListCalls:            &latestTurnCalls,
		activeListCalls:            &activeTurnCalls,
		interactionListCalls:       &pendingInteractionCalls,
		latestInteractionListCalls: &latestInteractionCalls,
	}
	service.UserProjectReader = fakeUserProjectReader{projects: []userprojectbiz.Project{{
		ID:    "project-1",
		Path:  "/workspace/project",
		Label: "Project",
	}}}

	page, err := service.ListSessionSections(context.Background(), "ws-1", ListSessionSectionsInput{
		LimitPerSection: 5,
		AgentTargetID:   "claude-target",
	})
	if err != nil {
		t.Fatalf("ListSessionSections returned error: %v", err)
	}
	if len(page.Sections) != 2 {
		t.Fatalf("sections = %d, want 2", len(page.Sections))
	}
	if got, want := sessionIDs(page.Pinned.Sessions), []string{"pinned-session"}; !slices.Equal(got, want) {
		t.Fatalf("pinned sessions = %#v, want %#v", got, want)
	}
	if !page.Pinned.HasMore || page.Pinned.NextCursor != "6000|pinned-session" {
		t.Fatalf("pinned page state = hasMore %v cursor %q", page.Pinned.HasMore, page.Pinned.NextCursor)
	}
	if page.Pinned.TotalCount != 3 {
		t.Fatalf("pinned total count = %d, want 3", page.Pinned.TotalCount)
	}
	if page.Sections[0].Kind != "project" || page.Sections[0].SectionKey != "project:/workspace/project" {
		t.Fatalf("project section = %#v", page.Sections[0])
	}
	if got, want := sessionIDs(page.Sections[0].Sessions), []string{"project-session"}; !slices.Equal(got, want) {
		t.Fatalf("project sessions = %#v, want %#v", got, want)
	}
	if !page.Sections[0].HasMore || page.Sections[0].NextCursor != "5000|project-session" {
		t.Fatalf("project page state = hasMore %v cursor %q", page.Sections[0].HasMore, page.Sections[0].NextCursor)
	}
	if page.Sections[0].TotalCount != 7 {
		t.Fatalf("project total count = %d, want 7", page.Sections[0].TotalCount)
	}
	if page.Sections[1].Kind != "conversations" || page.Sections[1].SectionKey != "conversations" {
		t.Fatalf("conversations section = %#v", page.Sections[1])
	}
	if reader.sectionBatchCalls != 1 || reader.singleSectionCalls != 0 {
		t.Fatalf("section reader calls = batch %d single %d, want one batch and no per-section reads", reader.sectionBatchCalls, reader.singleSectionCalls)
	}
	if reader.lastSectionsInput.AgentTargetID != "claude-target" || reader.lastSectionsInput.LimitPerSection != 5 {
		t.Fatalf("reader input = %#v, want filtered five-row first pages", reader.lastSectionsInput)
	}
	if latestTurnCalls != 1 || activeTurnCalls != 1 || pendingInteractionCalls != 1 || latestInteractionCalls != 1 {
		t.Fatalf(
			"turn projection reads = latest %d active %d pending-interactions %d latest-interactions %d, want one cross-section batch each",
			latestTurnCalls,
			activeTurnCalls,
			pendingInteractionCalls,
			latestInteractionCalls,
		)
	}
}

func TestServiceListSessionSectionsPropagatesReaderError(t *testing.T) {
	want := errors.New("section store unavailable")
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = &fakeSectionReader{sectionBatchErr: want}
	service.UserProjectReader = fakeUserProjectReader{}

	_, err := service.ListSessionSections(context.Background(), "ws-1", ListSessionSectionsInput{
		LimitPerSection: 5,
	})
	if !errors.Is(err, want) {
		t.Fatalf("ListSessionSections() error = %v, want original store error", err)
	}
}

func TestServiceListSessionSectionsRequiresBatchReader(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{}
	service.UserProjectReader = fakeUserProjectReader{}

	_, err := service.ListSessionSections(context.Background(), "ws-1", ListSessionSectionsInput{
		LimitPerSection: 5,
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("ListSessionSections() error = %v, want required batch reader", err)
	}
}

func TestServiceListSessionSectionsProductionReaderCanRetryAfterCancellation(t *testing.T) {
	store := openAgentServiceSQLiteStore(t)
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = NewActivityProjection(store)
	service.UserProjectReader = fakeUserProjectReader{}

	canceledContext, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := service.ListSessionSections(canceledContext, "ws-1", ListSessionSectionsInput{
		LimitPerSection: 5,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled ListSessionSections() error = %v, want context.Canceled", err)
	}
	if errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("canceled ListSessionSections() error = %v, must not be classified as invalid input", err)
	}

	page, err := service.ListSessionSections(context.Background(), "ws-1", ListSessionSectionsInput{
		LimitPerSection: 5,
	})
	if err != nil {
		t.Fatalf("retry ListSessionSections() error = %v", err)
	}
	if page.WorkspaceID != "ws-1" || len(page.Sections) != 1 || page.Sections[0].SectionKey != sessionSectionKeyConversations {
		t.Fatalf("retry page = %#v, want empty Chats section", page)
	}
}

func TestServiceListSessionPageReadersPropagateStorageErrors(t *testing.T) {
	want := errors.New("section page store unavailable")
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = &fakeSectionReader{singleSectionErr: want}

	t.Run("workspace list", func(t *testing.T) {
		listService := newIsolatedAgentService(newFakeRuntime())
		listService.SessionReader = &recordingSessionPageReader{err: want}
		_, err := listService.ListPage(context.Background(), "ws-1", ListSessionsInput{Limit: 5})
		if !errors.Is(err, want) {
			t.Fatalf("ListPage() error = %v, want original store error", err)
		}
	})

	t.Run("ordinary section", func(t *testing.T) {
		_, err := service.ListSessionSectionPage(context.Background(), "ws-1", ListSessionSectionPageInput{
			SectionKey: sessionSectionKeyConversations,
			Limit:      5,
		})
		if !errors.Is(err, want) {
			t.Fatalf("ListSessionSectionPage() error = %v, want original store error", err)
		}
	})

	t.Run("pinned", func(t *testing.T) {
		_, err := service.ListPinnedSessionPage(context.Background(), "ws-1", ListPinnedSessionPageInput{
			Limit: 5,
		})
		if !errors.Is(err, want) {
			t.Fatalf("ListPinnedSessionPage() error = %v, want original store error", err)
		}
	})
}

func TestServiceListSessionPageProductionReaderCanRetryAfterCancellation(t *testing.T) {
	store := openAgentServiceSQLiteStore(t)
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = NewActivityProjection(store)

	t.Run("ordinary section", func(t *testing.T) {
		canceledContext, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := service.ListSessionSectionPage(canceledContext, "ws-1", ListSessionSectionPageInput{
			SectionKey: sessionSectionKeyConversations,
			Limit:      5,
		})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled ListSessionSectionPage() error = %v, want context.Canceled", err)
		}
		if errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("canceled ListSessionSectionPage() error = %v, must not be classified as invalid input", err)
		}
		page, err := service.ListSessionSectionPage(context.Background(), "ws-1", ListSessionSectionPageInput{
			SectionKey: sessionSectionKeyConversations,
			Limit:      5,
		})
		if err != nil || page.SectionKey != sessionSectionKeyConversations || len(page.Sessions) != 0 {
			t.Fatalf("retry ListSessionSectionPage() page=%#v error=%v", page, err)
		}
	})

	t.Run("pinned", func(t *testing.T) {
		canceledContext, cancel := context.WithCancel(context.Background())
		cancel()
		_, err := service.ListPinnedSessionPage(canceledContext, "ws-1", ListPinnedSessionPageInput{
			Limit: 5,
		})
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled ListPinnedSessionPage() error = %v, want context.Canceled", err)
		}
		if errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("canceled ListPinnedSessionPage() error = %v, must not be classified as invalid input", err)
		}
		page, err := service.ListPinnedSessionPage(context.Background(), "ws-1", ListPinnedSessionPageInput{
			Limit: 5,
		})
		if err != nil || len(page.Sessions) != 0 {
			t.Fatalf("retry ListPinnedSessionPage() page=%#v error=%v", page, err)
		}
	})
}

func TestServiceListSessionSectionPageForwardsStableCursor(t *testing.T) {
	reader := &fakeSectionReader{}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = reader
	service.UserProjectReader = fakeUserProjectReader{projects: []userprojectbiz.Project{{
		ID:         "project-1",
		Path:       "/workspace/project",
		Label:      "Project",
		SectionKey: "project:/workspace/project",
	}}}

	section, err := service.ListSessionSectionPage(context.Background(), "ws-1", ListSessionSectionPageInput{
		SectionKey:    "project:/workspace/project",
		Cursor:        "4000|middle",
		Limit:         2,
		AgentTargetID: "claude-target",
	})
	if err != nil {
		t.Fatalf("ListSessionSectionPage returned error: %v", err)
	}
	if section.Kind != "project" || section.SectionKey != "project:/workspace/project" {
		t.Fatalf("section = %#v", section)
	}
	if reader.lastInput.SectionKey != "project:/workspace/project" ||
		reader.lastInput.CursorSortTimeUnixMS != 4000 ||
		reader.lastInput.CursorSessionID != "middle" ||
		reader.lastInput.Limit != 2 ||
		reader.lastInput.AgentTargetID != "claude-target" {
		t.Fatalf("reader input = %#v", reader.lastInput)
	}
}

func TestServiceListPinnedSessionPageForwardsStableCursor(t *testing.T) {
	reader := &fakeSectionReader{}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = reader

	page, err := service.ListPinnedSessionPage(context.Background(), "ws-1", ListPinnedSessionPageInput{
		Cursor:        "6000|pinned-session",
		Limit:         2,
		AgentTargetID: "claude-target",
	})
	if err != nil {
		t.Fatalf("ListPinnedSessionPage returned error: %v", err)
	}
	if page.HasMore {
		t.Fatalf("page = %#v, want empty page without hasMore", page)
	}
	if reader.lastInput.SectionKey != agentactivitybiz.PinnedSessionPageKey ||
		reader.lastInput.CursorSortTimeUnixMS != 6000 ||
		reader.lastInput.CursorSessionID != "pinned-session" ||
		reader.lastInput.Limit != 2 ||
		reader.lastInput.AgentTargetID != "claude-target" {
		t.Fatalf("reader input = %#v", reader.lastInput)
	}
}

func TestServiceListSessionSectionDeletionCandidatesForwardsFilters(t *testing.T) {
	reader := &fakeSectionReader{
		deletionCandidates: agentactivitybiz.SessionSectionDeletionCandidates{
			WorkspaceID: "ws-1", SectionKey: "project:/workspace/project",
			AgentTargetID: "claude-target", ExcludePinned: true,
			SessionIDs: []string{"session-1", "session-2"},
		},
	}
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = reader
	service.UserProjectReader = fakeUserProjectReader{projects: []userprojectbiz.Project{{
		ID: "project-1", Path: "/workspace/project", Label: "Project",
	}}}

	result, err := service.ListSessionSectionDeletionCandidates(context.Background(), "ws-1", ListSessionSectionDeletionCandidatesInput{
		SectionKey: "project:/workspace/project", AgentTargetID: "claude-target", ExcludePinned: true,
	})
	if err != nil {
		t.Fatalf("ListSessionSectionDeletionCandidates() error = %v", err)
	}
	if !slices.Equal(result.SessionIDs, []string{"session-1", "session-2"}) || !result.ExcludePinned {
		t.Fatalf("candidates = %#v", result)
	}
	if reader.lastDeletionCandidatesInput.AgentTargetID != "claude-target" || !reader.lastDeletionCandidatesInput.ExcludePinned {
		t.Fatalf("candidate input = %#v", reader.lastDeletionCandidatesInput)
	}
}

func TestServiceDeleteSessionsBatchClosesAllRuntimesBeforePersistence(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1"}
	runtime.sessions["ws-1:session-2"] = ProviderRuntimeSession{ID: "session-2", WorkspaceID: "ws-1"}
	reader := &fakeSectionReader{batchDeleteResult: agentactivitybiz.DeleteSessionsBatchResult{
		RemovedSessions: 2, RemovedSessionIDs: []string{"session-1", "session-2"},
	}}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = reader
	service.AgentSessionResourceReleaser = &fakeAgentSessionResourceReleaser{err: errors.New("release browser resources")}

	result, err := service.DeleteSessionsBatch(context.Background(), "ws-1", DeleteSessionsBatchInput{
		SessionIDs:                 []string{" session-1 ", "session-2"},
		RequiredRootRailSectionKey: " project:/workspace/app ",
		ExcludePinnedRoots:         true,
	})
	if err != nil {
		t.Fatalf("DeleteSessionsBatch() error = %v", err)
	}
	if len(runtime.closeCalls) != 2 || reader.batchDeleteCalls != 1 || !slices.Equal(reader.lastBatchDeleteInput.SessionIDs, []string{"session-1", "session-2"}) {
		t.Fatalf("close calls=%#v batch input=%#v calls=%d", runtime.closeCalls, reader.lastBatchDeleteInput, reader.batchDeleteCalls)
	}
	if reader.lastBatchDeleteInput.RequiredRootRailSectionKey != "project:/workspace/app" || !reader.lastBatchDeleteInput.ExcludePinnedRoots {
		t.Fatalf("conditional batch input = %#v", reader.lastBatchDeleteInput)
	}
	if result.RemovedSessions != 2 || !slices.Equal(result.CleanupFailedSessionIDs, []string{"session-1", "session-2"}) {
		t.Fatalf("result = %#v", result)
	}
}

func TestServiceDeleteSessionsBatchDoesNotPersistAfterRuntimeCloseFailure(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1"}
	runtime.closeErr = errors.New("close failed")
	reader := &fakeSectionReader{}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = reader

	if _, err := service.DeleteSessionsBatch(context.Background(), "ws-1", DeleteSessionsBatchInput{SessionIDs: []string{"session-1"}}); err == nil {
		t.Fatal("DeleteSessionsBatch() error = nil, want close failure")
	}
	if reader.batchDeleteCalls != 0 {
		t.Fatalf("batch delete calls = %d, want 0", reader.batchDeleteCalls)
	}
}

func TestServiceDeleteSessionsBatchRejectsBlankAndDuplicateIDs(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	reader := &fakeSectionReader{}
	service.SessionReader = reader
	for _, sessionIDs := range [][]string{nil, {" "}, {"session-1", " session-1 "}} {
		if _, err := service.DeleteSessionsBatch(context.Background(), "ws-1", DeleteSessionsBatchInput{SessionIDs: sessionIDs}); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("DeleteSessionsBatch(%#v) error = %v, want invalid argument", sessionIDs, err)
		}
	}
	if reader.batchDeleteCalls != 0 {
		t.Fatalf("batch delete calls = %d, want 0", reader.batchDeleteCalls)
	}
}

func sessionIDs(sessions []Session) []string {
	ids := make([]string, 0, len(sessions))
	for _, session := range sessions {
		ids = append(ids, session.ID)
	}
	return ids
}

func TestServiceListsActivePeersFromCanonicalSessionStatus(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				UserID:          "user-1",
				Provider:        "codex",
				Metadata:        agentactivitybiz.SessionMetadata{Visible: true},
				ActiveTurnID:    "turn-1",
				Title:           "Active work",
				CreatedAtUnixMS: 1000,
				UpdatedAtUnixMS: 2000,
			},
			"ws-1:session-2": {
				ID:              "session-2",
				WorkspaceID:     "ws-1",
				UserID:          "user-2",
				Provider:        "claude",
				Metadata:        agentactivitybiz.SessionMetadata{Visible: true},
				Title:           "Done",
				CreatedAtUnixMS: 2000,
				UpdatedAtUnixMS: 3000,
			},
		},
	}

	peers, err := service.ListActivePeers(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("ListActivePeers returned error: %v", err)
	}
	if len(peers.Agents) != 1 {
		t.Fatalf("peers = %#v", peers)
	}
	if peers.Agents[0].Session.ID != "session-1" || peers.Agents[0].SelfRelation != "unknown" {
		t.Fatalf("peers = %#v", peers)
	}
	if peers.SelfKnown || !peers.MayIncludeSelf || peers.Warning != "SELF_IDENTITY_UNAVAILABLE" {
		t.Fatalf("peer identity metadata = %#v", peers)
	}
}

func TestServiceDeletesPersistedSession(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	releaser := &fakeAgentSessionResourceReleaser{}
	service.AgentSessionResourceReleaser = releaser
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {
				ID:          "session-1",
				WorkspaceID: "ws-1",
				Provider:    "codex",
			},
		},
	}

	removed, err := service.Delete(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if !removed.Removed {
		t.Fatal("Delete removed = false, want true")
	}
	if _, err := service.Get(context.Background(), "ws-1", "session-1"); err != ErrSessionNotFound {
		t.Fatalf("Get after delete error = %v, want %v", err, ErrSessionNotFound)
	}
	if !slices.Equal(releaser.released, []string{"session-1"}) {
		t.Fatalf("released Agent resources = %#v", releaser.released)
	}
}

func TestServiceDeleteReportsPostCommitCleanupFailure(t *testing.T) {
	service := newIsolatedAgentService(newFakeRuntime())
	releaser := &fakeAgentSessionResourceReleaser{err: errors.New("release browser resources")}
	service.AgentSessionResourceReleaser = releaser
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
		"ws-1:session-1": {ID: "session-1", WorkspaceID: "ws-1", Provider: "codex"},
	}}

	result, err := service.Delete(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if !result.Removed || !result.CleanupFailed {
		t.Fatalf("Delete result = %#v, want committed delete with cleanup failure", result)
	}
	if !slices.Equal(releaser.released, []string{"session-1"}) {
		t.Fatalf("released Agent resources = %#v", releaser.released)
	}
}

func TestServiceGetReturnsLiveSessionWithoutLegacySessionReader(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Title: "Live session",
	}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = failingTurnStore{sessionMissing: true}

	session, err := service.Get(context.Background(), "ws-1", "session-1")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if session.ID != "session-1" || value(session.Title) != "Live session" {
		t.Fatalf("Get() session = %#v, want live runtime observation", session)
	}
}

func TestServiceDeleteNormalizesWrappedRuntimeSessionNotFound(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1"}
	runtime.closeErr = fmt.Errorf("runtime close: %w", ErrSessionNotFound)
	service := newIsolatedAgentService(runtime)
	service.SessionReader = &fakeSessionReader{sessions: map[string]PersistedSession{
		"ws-1:session-1": {ID: "session-1", WorkspaceID: "ws-1"},
	}}

	_, err := service.Delete(context.Background(), "ws-1", "session-1")
	if err != ErrSessionNotFound {
		t.Fatalf("Delete() error = %v, want canonical ErrSessionNotFound", err)
	}
}

func TestServiceDeleteClosesRuntimeSession(t *testing.T) {
	runtime := newFakeRuntime()
	service := newTestService(runtime)
	installFakeCanonicalSessionStore(service)
	session, err := service.Create(context.Background(), "ws-1", CreateSessionInput{
		AgentTargetID:  agenttargetbiz.IDLocalCodex,
		Provider:       "codex",
		InitialContent: TextPromptContent("hello"),
	})
	if err != nil {
		t.Fatalf("Create returned error: %v", err)
	}

	removed, err := service.Delete(context.Background(), "ws-1", session.ID)
	if err != nil {
		t.Fatalf("Delete returned error: %v", err)
	}
	if !removed.Removed {
		t.Fatal("Delete removed = false, want true")
	}
	if len(runtime.closeCalls) != 1 || runtime.closeCalls[0].AgentSessionID != session.ID {
		t.Fatalf("close calls = %#v", runtime.closeCalls)
	}
}

func TestServiceClearClosesRuntimeAndClearsPersistedSessions(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID:          "session-1",
		WorkspaceID: "ws-1",
		Provider:    "codex",
	}
	runtime.sessions["ws-2:session-2"] = ProviderRuntimeSession{
		ID:          "session-2",
		WorkspaceID: "ws-2",
		Provider:    "codex",
	}
	service := newIsolatedAgentService(runtime)
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:session-1": {ID: "session-1", WorkspaceID: "ws-1"},
			"ws-2:session-2": {ID: "session-2", WorkspaceID: "ws-2"},
		},
	}

	result, err := service.Clear(context.Background(), "ws-1")
	if err != nil {
		t.Fatalf("Clear returned error: %v", err)
	}
	if result.RemovedSessions != 1 {
		t.Fatalf("Clear removed sessions = %d, want 1", result.RemovedSessions)
	}
	if len(runtime.closeCalls) != 1 || runtime.closeCalls[0].AgentSessionID != "session-1" {
		t.Fatalf("close calls = %#v", runtime.closeCalls)
	}
	if _, ok := runtime.Session("ws-2", "session-2"); !ok {
		t.Fatal("runtime session for another workspace was closed")
	}
}
