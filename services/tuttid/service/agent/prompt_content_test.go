package agent

import (
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizePromptContentAcceptsImagePath(t *testing.T) {
	content, _, err := normalizePromptContent([]PromptContentBlock{{
		Type:     "image",
		MimeType: "image/png",
		Path:     " /tmp/screen.png ",
		Name:     " screen.png ",
	}})
	if err != nil {
		t.Fatalf("normalizePromptContent() error = %v, want nil", err)
	}
	if len(content) != 1 {
		t.Fatalf("content length = %d, want 1", len(content))
	}
	if content[0].Path != "/tmp/screen.png" {
		t.Fatalf("image path = %q, want trimmed path", content[0].Path)
	}
	if content[0].Data != "" {
		t.Fatalf("image data = %q, want empty", content[0].Data)
	}
}

func TestNormalizePromptContentAcceptsHTTPSImageURL(t *testing.T) {
	signedURL := "https://bucket.example/image.png?X-Amz-Signature=secret"
	content, _, err := normalizePromptContent([]PromptContentBlock{{
		Type: "image", MimeType: "image/png", URL: " " + signedURL + " ", AttachmentID: "attachment-1", Name: "screen.png",
	}})
	if err != nil {
		t.Fatalf("normalizePromptContent() error = %v, want nil", err)
	}
	if len(content) != 1 || content[0].URL != signedURL || content[0].AttachmentID != "attachment-1" {
		t.Fatalf("content = %#v, want URL-backed image metadata", content)
	}

	store := PromptAttachmentStore{RootDir: t.TempDir()}
	persisted, err := store.PersistRequestContent("workspace-1", "session-1", content)
	if err != nil {
		t.Fatalf("PersistRequestContent() error = %v", err)
	}
	hydrated, err := store.HydrateRuntimeContent("workspace-1", "session-1", persisted)
	if err != nil {
		t.Fatalf("HydrateRuntimeContent() error = %v", err)
	}
	if hydrated[0].URL != signedURL || hydrated[0].Data != "" {
		t.Fatalf("hydrated image = %#v, want URL without owner hydration", hydrated[0])
	}
}

func TestNormalizePromptContentRejectsUnsafeOrAmbiguousImageURL(t *testing.T) {
	for _, block := range []PromptContentBlock{
		{Type: "image", MimeType: "image/png", URL: "http://bucket.example/image.png"},
		{Type: "image", MimeType: "image/png", URL: "https://user:pass@bucket.example/image.png"},
		{Type: "image", MimeType: "image/png", URL: "https://bucket.example/image.png", Data: "aW1hZ2U="},
	} {
		if _, _, err := normalizePromptContent([]PromptContentBlock{block}); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("normalizePromptContent(%#v) error = %v, want ErrInvalidArgument", block, err)
		}
	}
}

func TestPromptAttachmentStoreRejectsDotPathSegments(t *testing.T) {
	store := PromptAttachmentStore{RootDir: t.TempDir()}
	for _, input := range []struct {
		name           string
		workspaceID    string
		agentSessionID string
		attachmentID   string
	}{
		{name: "session dotdot", workspaceID: "workspace-1", agentSessionID: "..", attachmentID: "attachment-1"},
		{name: "attachment dot", workspaceID: "workspace-1", agentSessionID: "session-1", attachmentID: "."},
	} {
		t.Run(input.name, func(t *testing.T) {
			_, err := store.attachmentPath(input.workspaceID, input.agentSessionID, input.attachmentID, "image/png")
			if !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("attachmentPath error = %v, want ErrInvalidArgument", err)
			}
		})
	}
}

func TestPromptAttachmentStoreUsesSessionScopedPath(t *testing.T) {
	root := t.TempDir()
	store := PromptAttachmentStore{RootDir: root}

	path, err := store.attachmentPath("workspace-1", "session-1", "attachment-1", "image/png")
	if err != nil {
		t.Fatalf("attachmentPath() error = %v", err)
	}

	want := filepath.Join(root, "agent", "attachments", "session-1", "attachment-1.png")
	if path != want {
		t.Fatalf("attachmentPath() = %q, want %q", path, want)
	}
	if strings.Contains(path, "workspace-1") {
		t.Fatalf("attachment path leaks workspace id: %q", path)
	}
}

func TestPromptAttachmentStoreLocalPathRequiresExistingAttachment(t *testing.T) {
	root := t.TempDir()
	store := PromptAttachmentStore{RootDir: root}
	path, err := store.attachmentPath("workspace-1", "session-1", "attachment-1", "image/png")
	if err != nil {
		t.Fatalf("attachmentPath() error = %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte("png"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	got, err := store.LocalPath("workspace-1", "session-1", "attachment-1", "image/png")
	if err != nil {
		t.Fatalf("LocalPath() error = %v", err)
	}
	if got != path {
		t.Fatalf("LocalPath() = %q, want %q", got, path)
	}

	if _, err := store.LocalPath("workspace-1", "session-1", "missing", "image/png"); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("LocalPath() missing error = %v, want ErrSessionNotFound", err)
	}
}

func TestPromptAttachmentStorePersistsPathBackedImage(t *testing.T) {
	root := t.TempDir()
	stateRoot := filepath.Join(root, "state")
	sourceRoot := filepath.Join(stateRoot, "agent-prompt-assets")
	if err := os.MkdirAll(sourceRoot, 0o700); err != nil {
		t.Fatalf("mkdir source root: %v", err)
	}
	source := filepath.Join(sourceRoot, "source.png")
	if err := os.WriteFile(source, []byte("image-bytes"), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}
	store := PromptAttachmentStore{RootDir: stateRoot}

	persisted, err := store.PersistRequestContent("workspace-1", "session-1", []PromptContentBlock{{
		Type:     "image",
		MimeType: "image/png",
		Path:     source,
		Name:     "screen.png",
	}})
	if err != nil {
		t.Fatalf("PersistRequestContent() error = %v", err)
	}
	if len(persisted) != 1 {
		t.Fatalf("persisted length = %d, want 1", len(persisted))
	}
	if persisted[0].AttachmentID == "" {
		t.Fatalf("attachment id is empty")
	}
	if persisted[0].Data != "" || persisted[0].Path != "" {
		t.Fatalf("persisted image = %#v, want attachmentId without data/path", persisted[0])
	}

	hydrated, err := store.HydrateRuntimeContent("workspace-1", "session-1", persisted)
	if err != nil {
		t.Fatalf("HydrateRuntimeContent() error = %v", err)
	}
	if got := hydrated[0].Data; got != base64.StdEncoding.EncodeToString([]byte("image-bytes")) {
		t.Fatalf("hydrated data = %q, want source bytes encoded", got)
	}
}

func TestPromptAttachmentStoreRejectsPathBackedImageOutsideSourceRoot(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "outside.png")
	if err := os.WriteFile(source, []byte("image-bytes"), 0o600); err != nil {
		t.Fatalf("write source: %v", err)
	}
	store := PromptAttachmentStore{RootDir: filepath.Join(root, "state")}

	_, err := store.PersistRequestContent("workspace-1", "session-1", []PromptContentBlock{{
		Type:     "image",
		MimeType: "image/png",
		Path:     source,
		Name:     "screen.png",
	}})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("PersistRequestContent() error = %v, want ErrInvalidArgument", err)
	}
}

func TestPromptAttachmentStoreRejectsSymlinkEscapingSourceRoot(t *testing.T) {
	root := t.TempDir()
	stateRoot := filepath.Join(root, "state")
	sourceRoot := filepath.Join(stateRoot, "agent-prompt-assets")
	if err := os.MkdirAll(sourceRoot, 0o700); err != nil {
		t.Fatalf("mkdir source root: %v", err)
	}
	outside := filepath.Join(root, "outside.png")
	if err := os.WriteFile(outside, []byte("image-bytes"), 0o600); err != nil {
		t.Fatalf("write outside: %v", err)
	}
	link := filepath.Join(sourceRoot, "link.png")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	store := PromptAttachmentStore{RootDir: stateRoot}

	_, err := store.PersistRequestContent("workspace-1", "session-1", []PromptContentBlock{{
		Type:     "image",
		MimeType: "image/png",
		Path:     link,
		Name:     "screen.png",
	}})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("PersistRequestContent() error = %v, want ErrInvalidArgument", err)
	}
}

func TestPromptAttachmentStoreRejectsOversizedPathBackedImage(t *testing.T) {
	root := t.TempDir()
	stateRoot := filepath.Join(root, "state")
	sourceRoot := filepath.Join(stateRoot, "agent-prompt-assets")
	if err := os.MkdirAll(sourceRoot, 0o700); err != nil {
		t.Fatalf("mkdir source root: %v", err)
	}
	source := filepath.Join(sourceRoot, "large.png")
	file, err := os.Create(source)
	if err != nil {
		t.Fatalf("create source: %v", err)
	}
	if err := file.Truncate(maxPromptAttachmentSourceBytes + 1); err != nil {
		_ = file.Close()
		t.Fatalf("truncate source: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("close source: %v", err)
	}
	store := PromptAttachmentStore{RootDir: stateRoot}

	_, err = store.PersistRequestContent("workspace-1", "session-1", []PromptContentBlock{{
		Type:     "image",
		MimeType: "image/png",
		Path:     source,
		Name:     "screen.png",
	}})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("PersistRequestContent() error = %v, want ErrInvalidArgument", err)
	}
}
