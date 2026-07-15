package agent

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type generatedFileReaderStub struct {
	input agentactivitybiz.ListWorkspaceGeneratedFilesInput
}

func (*generatedFileReaderStub) ListSessionMessages(
	agentactivitybiz.ListSessionMessagesInput,
) (SessionMessagesPage, bool) {
	return SessionMessagesPage{}, false
}

func (s *generatedFileReaderStub) ListWorkspaceGeneratedFiles(
	input agentactivitybiz.ListWorkspaceGeneratedFilesInput,
) (GeneratedFileList, bool) {
	s.input = input
	return GeneratedFileList{WorkspaceID: input.WorkspaceID, Files: []GeneratedFile{}}, true
}

func TestListGeneratedFilesNormalizesAgentTargetFilters(t *testing.T) {
	t.Parallel()

	reader := &generatedFileReaderStub{}
	service := &Service{MessageReader: reader}
	_, err := service.ListGeneratedFiles(context.Background(), " workspace-1 ", ListGeneratedFilesInput{
		AgentTargetIDs: []string{" local:codex ", "local:claude-code", "local:codex"},
		Limit:          10,
	})
	if err != nil {
		t.Fatalf("ListGeneratedFiles() error = %v", err)
	}
	if !reflect.DeepEqual(reader.input.AgentTargetIDs, []string{"local:codex", "local:claude-code"}) {
		t.Fatalf("agent target ids = %#v, want normalized unique ids", reader.input.AgentTargetIDs)
	}
}

func TestListGeneratedFilesRejectsEmptyAgentTargetFilters(t *testing.T) {
	t.Parallel()

	service := &Service{MessageReader: &generatedFileReaderStub{}}
	_, err := service.ListGeneratedFiles(context.Background(), "workspace-1", ListGeneratedFilesInput{
		AgentTargetIDs: []string{" ", ""},
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("ListGeneratedFiles() error = %v, want ErrInvalidArgument", err)
	}
}

func TestListGeneratedFilesRejectsTooManyAgentTargetFilters(t *testing.T) {
	t.Parallel()

	ids := make([]string, MaxGeneratedFileAgentTargetFilters+1)
	for index := range ids {
		ids[index] = fmt.Sprintf("agent-%d", index)
	}
	service := &Service{MessageReader: &generatedFileReaderStub{}}
	_, err := service.ListGeneratedFiles(context.Background(), "workspace-1", ListGeneratedFilesInput{
		AgentTargetIDs: ids,
	})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("ListGeneratedFiles() error = %v, want ErrInvalidArgument", err)
	}
}
