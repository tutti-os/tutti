package agent

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type generatedFileReaderStub struct {
	calls int
	input agentactivitybiz.ListWorkspaceGeneratedFileTurnsInput
	turns []agentactivitybiz.GeneratedFileTurn
}

func (*generatedFileReaderStub) ListSessionMessages(
	agentactivitybiz.ListSessionMessagesInput,
) (SessionMessagesPage, bool) {
	return SessionMessagesPage{}, false
}

func (s *generatedFileReaderStub) ListWorkspaceGeneratedFileTurns(
	_ context.Context,
	input agentactivitybiz.ListWorkspaceGeneratedFileTurnsInput,
) (agentactivitybiz.GeneratedFileTurnList, bool) {
	s.calls++
	s.input = input
	return agentactivitybiz.GeneratedFileTurnList{WorkspaceID: input.WorkspaceID, Turns: s.turns}, true
}

func TestListGeneratedFilesCombinesBeforeFiltering(t *testing.T) {
	t.Parallel()

	reader := &generatedFileReaderStub{turns: []agentactivitybiz.GeneratedFileTurn{
		{
			AgentTargetID: testGeneratedFileAgentB, CWD: "/workspace/project", RailSectionKind: "project",
			RailProjectPath: "/workspace/project", SettledAtUnixMS: 300,
			Changes: []agentactivitybiz.GeneratedFileTurnChange{
				{Path: "shared.md", Change: "deleted"},
				{Path: "docs/user-guide.md", Change: "modified"},
			},
		},
		{
			AgentTargetID: testGeneratedFileAgentA, CWD: "/workspace/project", RailSectionKind: "project",
			RailProjectPath: "/workspace/project", SettledAtUnixMS: 200,
			Changes: []agentactivitybiz.GeneratedFileTurnChange{
				{Path: "shared.md", Change: "added"},
				{Path: "src/user-controller.ts", Change: "added"},
				{Path: "/workspace/outside-user.md", Change: "added"},
				{Path: "ghost.md", Change: "unknown"},
			},
		},
		{
			AgentTargetID: testGeneratedFileAgentA, CWD: "/workspace/project", RailSectionKind: "project",
			RailProjectPath: "/workspace/project", SettledAtUnixMS: 100,
			Changes: []agentactivitybiz.GeneratedFileTurnChange{{Path: "docs/user-guide.md", Change: "added"}},
		},
	}}
	service := &Service{MessageReader: reader}
	result, err := service.ListGeneratedFiles(context.Background(), " workspace-1 ", ListGeneratedFilesInput{
		AgentTargetIDs: []string{" agent-a ", "agent-a"},
		Limit:          10,
		Query:          "user",
		SectionKey:     " project:/workspace ",
	})
	if err != nil {
		t.Fatalf("ListGeneratedFiles() error = %v", err)
	}
	if !reflect.DeepEqual(result.Files, []GeneratedFile{{
		Path: "/workspace/project/src/user-controller.ts", Label: "user-controller.ts",
	}}) {
		t.Fatalf("files = %#v", result.Files)
	}
	if reader.input.WorkspaceID != "workspace-1" || reader.input.SectionKey != "project:/workspace" {
		t.Fatalf("reader input = %#v", reader.input)
	}
}

func TestListGeneratedFilesRanksThenPaginatesBoundedResults(t *testing.T) {
	t.Parallel()

	changes := make([]agentactivitybiz.GeneratedFileTurnChange, 0, 35)
	for index := 0; index < 35; index++ {
		changes = append(changes, agentactivitybiz.GeneratedFileTurnChange{
			Path: fmt.Sprintf("docs/file-%02d.md", index), Change: "added",
		})
	}
	reader := &generatedFileReaderStub{turns: []agentactivitybiz.GeneratedFileTurn{{
		AgentTargetID: testGeneratedFileAgentA, CWD: "/workspace/project", RailSectionKind: "project",
		RailProjectPath: "/workspace/project", SettledAtUnixMS: 100, Changes: changes,
	}}}
	service := &Service{MessageReader: reader}
	first, err := service.ListGeneratedFiles(context.Background(), "workspace-1", ListGeneratedFilesInput{
		Limit: 30, SectionKey: "project:/workspace",
	})
	if err != nil {
		t.Fatalf("first page error = %v", err)
	}
	if len(first.Files) != 30 || !first.HasMore || first.NextCursor != "v1:30" {
		t.Fatalf("first page = %#v", first)
	}
	second, err := service.ListGeneratedFiles(context.Background(), "workspace-1", ListGeneratedFilesInput{
		Cursor: first.NextCursor, Limit: 30, SectionKey: "project:/workspace",
	})
	if err != nil {
		t.Fatalf("second page error = %v", err)
	}
	if len(second.Files) != 5 || second.HasMore || second.NextCursor != "" {
		t.Fatalf("second page = %#v", second)
	}
}

func TestListGeneratedFilesCachesBaseForTenSeconds(t *testing.T) {
	t.Parallel()

	now := time.Unix(100, 0)
	reader := &generatedFileReaderStub{}
	service := &Service{MessageReader: reader, GeneratedFilesClock: func() time.Time { return now }}
	input := ListGeneratedFilesInput{SectionKey: "conversations"}
	if _, err := service.ListGeneratedFiles(context.Background(), "workspace-1", input); err != nil {
		t.Fatal(err)
	}
	now = now.Add(9 * time.Second)
	if _, err := service.ListGeneratedFiles(context.Background(), "workspace-1", input); err != nil {
		t.Fatal(err)
	}
	if reader.calls != 1 {
		t.Fatalf("reader calls before expiry = %d, want 1", reader.calls)
	}
	now = now.Add(time.Second)
	if _, err := service.ListGeneratedFiles(context.Background(), "workspace-1", input); err != nil {
		t.Fatal(err)
	}
	if reader.calls != 2 {
		t.Fatalf("reader calls after expiry = %d, want 2", reader.calls)
	}
}

func TestListGeneratedFilesRejectsInvalidInputs(t *testing.T) {
	t.Parallel()

	service := &Service{MessageReader: &generatedFileReaderStub{}}
	for _, input := range []ListGeneratedFilesInput{
		{AgentTargetIDs: []string{" ", ""}, SectionKey: "conversations"},
		{Cursor: "30", SectionKey: "conversations"},
		{Cursor: "v1:201", SectionKey: "conversations"},
	} {
		if _, err := service.ListGeneratedFiles(context.Background(), "workspace-1", input); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("ListGeneratedFiles(%#v) error = %v, want ErrInvalidArgument", input, err)
		}
	}
	ids := make([]string, MaxGeneratedFileAgentTargetFilters+1)
	for index := range ids {
		ids[index] = fmt.Sprintf("agent-%d", index)
	}
	if _, err := service.ListGeneratedFiles(context.Background(), "workspace-1", ListGeneratedFilesInput{
		AgentTargetIDs: ids, SectionKey: "conversations",
	}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("too many agent target filters error = %v", err)
	}
}

const (
	testGeneratedFileAgentA = "agent-a"
	testGeneratedFileAgentB = "agent-b"
)
