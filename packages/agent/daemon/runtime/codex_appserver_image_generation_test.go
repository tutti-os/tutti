package agentruntime

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestAppServerImageGenerationPublishesFileBackedContentWithoutBase64(t *testing.T) {
	t.Parallel()

	const (
		savedPath = "/Users/demo/.tutti/agent/runs/session/codex-home/generated_images/thread/ig_123.png"
		base64    = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
	)
	update, ok := appServerItemToolCallUpdate(map[string]any{
		"id":            "ig_123",
		"type":          "imageGeneration",
		"status":        "completed",
		"revisedPrompt": "a joyful little girl dancing",
		"savedPath":     savedPath,
		"result":        base64,
	}, true)
	if !ok {
		t.Fatal("imageGeneration item did not produce a tool-call update")
	}

	rawOutput, ok := update["rawOutput"].(map[string]any)
	if !ok {
		t.Fatalf("rawOutput = %#v, want map", update["rawOutput"])
	}
	if got := asString(rawOutput["savedPath"]); got != savedPath {
		t.Fatalf("rawOutput.savedPath = %q, want %q", got, savedPath)
	}
	if _, exists := rawOutput["result"]; exists {
		t.Fatalf("rawOutput.result must not retain image base64: %#v", rawOutput["result"])
	}

	content, ok := update["content"].([]any)
	if !ok || len(content) != 2 {
		t.Fatalf("content = %#v, want prompt and image entries", update["content"])
	}
	prompt := payloadObject(payloadObject(content[0])["content"])
	if got := asString(prompt["text"]); got != "Revised prompt: a joyful little girl dancing" {
		t.Fatalf("prompt text = %q", got)
	}
	image := payloadObject(payloadObject(content[1])["content"])
	if got := asString(image["type"]); got != "image" {
		t.Fatalf("image type = %q, want image", got)
	}
	if got := asString(image["uri"]); got != savedPath {
		t.Fatalf("image uri = %q, want %q", got, savedPath)
	}
	if got := asString(image["mimeType"]); got != "image/png" {
		t.Fatalf("image mimeType = %q, want image/png", got)
	}

	session := Session{Provider: ProviderCodex, AgentSessionID: "agent-image", RoomID: "room-image"}
	event, ok := acpToolCallEventWithID(session, "event-image", "turn-image", update)
	if !ok {
		t.Fatal("normalized imageGeneration update did not produce an event")
	}
	encoded, err := json.Marshal(event.Payload.Metadata)
	if err != nil {
		t.Fatalf("marshal normalized payload: %v", err)
	}
	if strings.Contains(string(encoded), base64) {
		t.Fatalf("normalized payload retained image base64: %s", encoded)
	}
	if !strings.Contains(string(encoded), savedPath) {
		t.Fatalf("normalized payload lost saved image path: %s", encoded)
	}

	messageUpdate, ok := messageUpdateFromSessionEvent(
		canonical.EventSource{Provider: string(ProviderCodex)},
		event,
		session.AgentSessionID,
		1,
	)
	if !ok {
		t.Fatal("normalized imageGeneration event did not produce a durable message update")
	}
	encoded, err = json.Marshal(messageUpdate.Payload)
	if err != nil {
		t.Fatalf("marshal durable message payload: %v", err)
	}
	if strings.Contains(string(encoded), base64) {
		t.Fatalf("durable message payload retained image base64: %s", encoded)
	}
	if !strings.Contains(string(encoded), savedPath) {
		t.Fatalf("durable message payload lost saved image path: %s", encoded)
	}
}

func TestAppServerImageGenerationInfersMimeTypeFromSavedPath(t *testing.T) {
	t.Parallel()

	if got := appServerImageMimeType("/tmp/generated.webp"); got != "image/webp" {
		t.Fatalf("webp mime type = %q, want image/webp", got)
	}
	if got := appServerImageMimeType("/tmp/generated.unknown"); got != "image/png" {
		t.Fatalf("unknown mime type = %q, want image/png", got)
	}
}
