package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
)

func TestCleanupPurgedSessionResourcesSkipsExistingCanonicalSession(t *testing.T) {
	for _, test := range []struct {
		name   string
		reader fakeSessionReader
	}{
		{
			name: "live",
			reader: fakeSessionReader{sessions: map[string]PersistedSession{
				"workspace-2:session-1": {WorkspaceID: "workspace-2", ID: "session-1"},
			}},
		},
		{
			name: "tombstoned",
			reader: fakeSessionReader{
				sessions:   map[string]PersistedSession{},
				tombstoned: map[string]bool{"workspace-2:session-1": true},
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			attachments := PromptAttachmentStore{RootDir: root}
			attachmentPath, err := attachments.attachmentPath(
				"workspace-1", "session-1", "attachment-1", "image/png",
			)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.MkdirAll(filepath.Dir(attachmentPath), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(attachmentPath, []byte("preserve"), 0o600); err != nil {
				t.Fatal(err)
			}
			releaser := &fakeAgentSessionResourceReleaser{}
			service := &Service{
				SessionReader:                test.reader,
				AgentSessionResourceReleaser: releaser,
				PromptAttachmentStore:        attachments,
			}

			if err := service.CleanupPurgedSessionResources(
				context.Background(), "workspace-1", "session-1",
			); err != nil {
				t.Fatalf("CleanupPurgedSessionResources() error = %v", err)
			}
			if len(releaser.released) != 0 {
				t.Fatalf("released resources = %#v, want defensive skip", releaser.released)
			}
			if _, err := os.Stat(attachmentPath); err != nil {
				t.Fatalf("canonical Session attachment was removed: %v", err)
			}
		})
	}
}

func TestRecoverableDeletionKeepsGlobalResourcesOwnedByAnotherWorkspace(t *testing.T) {
	cleanupCalls := make([]runtimeprep.CleanupInput, 0, 1)
	unregisterCalls := make([][2]string, 0, 1)
	releaser := &fakeAgentSessionResourceReleaser{}
	service := &Service{
		SessionReader: fakeSessionReader{sessions: map[string]PersistedSession{
			"workspace-2:session-1": {WorkspaceID: "workspace-2", ID: "session-1"},
		}},
		RuntimePreparer:              fakeRuntimePreparer{cleanupCalls: &cleanupCalls},
		ModelGateway:                 fakeModelGateway{unregisterCalls: &unregisterCalls},
		AgentSessionResourceReleaser: releaser,
	}

	if err := service.releaseSessionResourcesForRecoverableDeletion(
		context.Background(),
		"workspace-1",
		"session-1",
	); err != nil {
		t.Fatalf("releaseSessionResourcesForRecoverableDeletion() error = %v", err)
	}
	if len(releaser.released) != 0 {
		t.Fatalf("released global resources = %#v, want shared live owner preserved", releaser.released)
	}
	if len(cleanupCalls) != 1 ||
		cleanupCalls[0].WorkspaceID != "workspace-1" ||
		cleanupCalls[0].AgentSessionID != "session-1" ||
		!cleanupCalls[0].PreserveRuntimeRoot {
		t.Fatalf("workspace runtime cleanup calls = %#v", cleanupCalls)
	}
	if len(unregisterCalls) != 1 || unregisterCalls[0] != [2]string{"workspace-1", "session-1"} {
		t.Fatalf("model gateway unregister calls = %#v", unregisterCalls)
	}
}

func TestCleanupPurgedSessionResourcesIsIdempotentAcrossWorkspaceQueueItems(t *testing.T) {
	root := t.TempDir()
	attachments := PromptAttachmentStore{RootDir: root}
	attachmentPath, err := attachments.attachmentPath(
		"workspace-1", "session-1", "attachment-1", "image/png",
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(attachmentPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(attachmentPath, []byte("delete once"), 0o600); err != nil {
		t.Fatal(err)
	}
	service := &Service{
		SessionReader:                fakeSessionReader{sessions: map[string]PersistedSession{}},
		AgentSessionResourceReleaser: &fakeAgentSessionResourceReleaser{},
		PromptAttachmentStore:        attachments,
	}

	for _, workspaceID := range []string{"workspace-1", "workspace-2"} {
		if err := service.CleanupPurgedSessionResources(
			context.Background(), workspaceID, "session-1",
		); err != nil {
			t.Fatalf("CleanupPurgedSessionResources(%s) error = %v", workspaceID, err)
		}
	}
	if _, err := os.Stat(attachmentPath); !os.IsNotExist(err) {
		t.Fatalf("attachment path still exists or stat failed unexpectedly: %v", err)
	}
}
