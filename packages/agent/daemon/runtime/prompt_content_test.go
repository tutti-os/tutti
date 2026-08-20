package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func textPrompt(text string) []PromptContentBlock {
	return []PromptContentBlock{{Type: "text", Text: text}}
}

func TestACPPromptImageSupportedReadsStandardInitializeShape(t *testing.T) {
	t.Parallel()

	tests := map[string]struct {
		raw  string
		want bool
	}{
		"standard agentCapabilities.promptCapabilities.image true": {
			raw:  `{"protocolVersion":1,"agentCapabilities":{"promptCapabilities":{"audio":false,"embeddedContext":true,"image":true}}}`,
			want: true,
		},
		"standard agentCapabilities.promptCapabilities.image false": {
			raw:  `{"protocolVersion":1,"agentCapabilities":{"promptCapabilities":{"image":false}}}`,
			want: false,
		},
		"standard agentCapabilities without promptCapabilities": {
			raw:  `{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}`,
			want: false,
		},
		"legacy top-level promptCapabilities.image true": {
			raw:  `{"protocolVersion":1,"promptCapabilities":{"image":true}}`,
			want: true,
		},
		"legacy agentCapabilities.image true": {
			raw:  `{"protocolVersion":1,"agentCapabilities":{"image":true}}`,
			want: true,
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if got := acpPromptImageSupported(json.RawMessage(test.raw)); got != test.want {
				t.Fatalf("acpPromptImageSupported(%s) = %v, want %v", test.raw, got, test.want)
			}
		})
	}
}

func testRemotePromptImageMaterializer(t *testing.T) (string, providerPromptImageMaterializer) {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/image.png" {
			http.Error(response, "unexpected request", http.StatusBadRequest)
			return
		}
		response.Header().Set("Content-Type", "image/png")
		_, _ = response.Write([]byte("hi"))
	}))
	t.Cleanup(server.Close)
	return server.URL + "/image.png", func(ctx context.Context, content []PromptContentBlock) ([]PromptContentBlock, error) {
		return materializeProviderPromptImagesWithClient(ctx, content, server.Client())
	}
}

func TestNormalizeRuntimePromptContentPreservesURLOnlyImage(t *testing.T) {
	signedURL := "https://bucket.example/image.webp?token=secret"
	content := normalizeRuntimePromptContent([]PromptContentBlock{{Type: "image", MimeType: " image/webp ", URL: " " + signedURL + " ", Name: " image.webp "}})
	if len(content) != 1 || content[0].URL != signedURL || content[0].Data != "" {
		t.Fatalf("content = %#v, want normalized URL-only image", content)
	}
}

func TestProjectRuntimeConnectorPromptContentUsesNativeInterfaces(t *testing.T) {
	content := normalizeRuntimePromptContent([]PromptContentBlock{
		{Type: "text", Text: "list my calendar events"},
		{Type: "connector", ConnectorKey: " lark-cli "},
	})
	projected := projectRuntimeConnectorPromptContent(content)
	if len(projected) != 2 {
		t.Fatalf("projected content = %#v, want instruction and user text", projected)
	}
	if projected[0].Type != "text" || !strings.Contains(projected[0].Text, "lark-cli") ||
		!strings.Contains(projected[0].Text, "connector-owned Skills") ||
		!strings.Contains(projected[0].Text, "provider's native Skill system") ||
		!strings.Contains(projected[0].Text, "injected `connector` MCP server") ||
		!strings.Contains(projected[0].Text, "normal shell") ||
		!strings.Contains(projected[0].Text, "Never use a similarly named user-global") {
		t.Fatalf("connector instruction = %#v", projected[0])
	}
	if projected[1].Text != "list my calendar events" {
		t.Fatalf("user prompt = %#v, want preserved text", projected[1])
	}
	for _, block := range projected {
		if block.Type == "connector" {
			t.Fatalf("provider content leaked connector block: %#v", projected)
		}
	}
}

func TestPrependConnectorRoutingUpdateRendersProviderOnlyInstruction(t *testing.T) {
	content := []PromptContentBlock{{Type: "text", Text: "check my calendar"}}
	if got := prependConnectorRoutingUpdate(content, nil); len(got) != 1 || got[0].Text != "check my calendar" {
		t.Fatalf("nil update projected content = %#v, want unchanged", got)
	}

	index := "calendar=Calendar|日历;github=GitHub"
	updated := prependConnectorRoutingUpdate(content, &index)
	if len(updated) != 2 || updated[0].Type != "text" {
		t.Fatalf("updated content = %#v, want prepended instruction", updated)
	}
	if !strings.Contains(updated[0].Text, "Connector routing update") ||
		!strings.Contains(updated[0].Text, index) ||
		!strings.Contains(updated[0].Text, "supersedes the connector alias index") ||
		!strings.Contains(updated[0].Text, "connector available --json") {
		t.Fatalf("routing update instruction = %q", updated[0].Text)
	}
	if updated[1].Text != "check my calendar" {
		t.Fatalf("user prompt = %#v, want preserved text", updated[1])
	}

	empty := "  "
	drained := prependConnectorRoutingUpdate(content, &empty)
	if len(drained) != 2 || !strings.Contains(drained[0].Text, "no Tutti connectors are currently available") {
		t.Fatalf("empty index instruction = %#v", drained)
	}
}

func TestConnectorRoutingUpdatePrecedesSelectedConnectorInstruction(t *testing.T) {
	content := normalizeRuntimePromptContent([]PromptContentBlock{
		{Type: "text", Text: "list my calendar events"},
		{Type: "connector", ConnectorKey: "lark-cli"},
	})
	index := "lark-cli=Lark CLI|飞书"
	projected := prependConnectorRoutingUpdate(projectRuntimeConnectorPromptContent(content), &index)
	if len(projected) != 3 {
		t.Fatalf("projected content = %#v, want update, selection, and user text", projected)
	}
	if !strings.Contains(projected[0].Text, "Connector routing update") ||
		!strings.Contains(projected[1].Text, "Selected local connector(s): lark-cli") ||
		projected[2].Text != "list my calendar events" {
		t.Fatalf("projected order = %#v", projected)
	}
}

func TestProviderPromptImageHTTPClientUsesSystemNetworkForReservedAddress(t *testing.T) {
	t.Parallel()

	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "image/png")
		_, _ = response.Write([]byte("hi"))
	}))
	defer server.Close()

	client := newProviderPromptImageHTTPClient(time.Second)
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("prompt image transport = %T, want *http.Transport", client.Transport)
	}
	testTransport, ok := server.Client().Transport.(*http.Transport)
	if !ok {
		t.Fatalf("test transport = %T, want *http.Transport", server.Client().Transport)
	}
	transport = transport.Clone()
	transport.TLSClientConfig = testTransport.TLSClientConfig.Clone()
	client.Transport = transport

	content, err := materializeProviderPromptImagesWithClient(context.Background(), []PromptContentBlock{{
		Type: "image", MimeType: "image/png", URL: server.URL + "/image.png",
	}}, client)
	if err != nil {
		t.Fatalf("materialize reserved-address image: %v", err)
	}
	if len(content) != 1 || content[0].URL != "" || content[0].Data != "aGk=" {
		t.Fatalf("materialized content = %#v, want inline image data", content)
	}
}

func TestMaterializeProviderPromptImagesRejectsHTTPRedirect(t *testing.T) {
	t.Parallel()

	var requests int
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		http.Redirect(response, request, "http://127.0.0.1/image.png", http.StatusFound)
	}))
	defer server.Close()

	_, err := materializeProviderPromptImagesWithClient(context.Background(), []PromptContentBlock{{
		Type: "image", MimeType: "image/png", URL: server.URL + "/start",
	}}, server.Client())
	if err == nil {
		t.Fatal("materialize error = nil, want HTTP redirect rejection")
	}
	if requests != 1 {
		t.Fatalf("server received %d requests, want only the HTTPS request", requests)
	}
}

func TestMaterializeProviderPromptImagesDoesNotForwardSignedURLReferer(t *testing.T) {
	t.Parallel()

	var requests int
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		switch request.URL.Path {
		case "/start":
			http.Redirect(response, request, "/image.png", http.StatusFound)
		case "/image.png":
			if referer := request.Header.Get("Referer"); referer != "" {
				t.Errorf("redirect Referer = %q, want empty", referer)
			}
			response.Header().Set("Content-Type", "image/png")
			_, _ = response.Write([]byte("hi"))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	content, err := materializeProviderPromptImagesWithClient(context.Background(), []PromptContentBlock{{
		Type: "image", MimeType: "image/png", URL: server.URL + "/start?X-Amz-Signature=secret",
	}}, server.Client())
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if requests != 2 || len(content) != 1 || content[0].Data != "aGk=" {
		t.Fatalf("requests = %d, content = %#v, want redirected inline image", requests, content)
	}
}

func TestMaterializeProviderPromptImagesInlinesRemoteURLForProviderPayloads(t *testing.T) {
	t.Parallel()

	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/image.png" {
			t.Fatalf("request = %s %s, want GET /image.png", request.Method, request.URL.Path)
		}
		response.Header().Set("Content-Type", "image/png")
		_, _ = response.Write([]byte("hi"))
	}))
	defer server.Close()

	content, err := materializeProviderPromptImagesWithClient(context.Background(), []PromptContentBlock{
		{Type: "text", Text: "look"},
		{Type: "image", MimeType: "image/png", URL: server.URL + "/image.png", Name: "image.png"},
	}, server.Client())
	if err != nil {
		t.Fatalf("materializeProviderPromptImagesWithClient: %v", err)
	}
	if content[1].URL != "" || content[1].Data != "aGk=" || content[1].Name != "image.png" {
		t.Fatalf("materialized image = %#v", content[1])
	}

	codexInput := appServerUserInput(content)
	if got := asString(codexInput[1]["url"]); got != "data:image/png;base64,aGk=" {
		t.Fatalf("Codex image URL = %q", got)
	}
	acpInput := promptContentForACP(content)
	if got := asString(acpInput[1]["data"]); got != "aGk=" {
		t.Fatalf("ACP image data = %q", got)
	}
	if got := asString(acpInput[1]["mimeType"]); got != "image/png" {
		t.Fatalf("ACP image mimeType = %q", got)
	}
	claudeSDKInput := promptContentForClaudeSDK(content, "look")
	if got := asString(claudeSDKInput[1]["data"]); got != "aGk=" {
		t.Fatalf("Claude SDK image data = %q", got)
	}
	if got := asString(claudeSDKInput[1]["url"]); got != "" {
		t.Fatalf("Claude SDK image URL = %q, want empty", got)
	}
}

func TestMaterializeProviderPromptImagesRejectsMismatchedResponseMimeType(t *testing.T) {
	t.Parallel()

	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "text/html")
		_, _ = response.Write([]byte("not an image"))
	}))
	defer server.Close()

	_, err := materializeProviderPromptImagesWithClient(context.Background(), []PromptContentBlock{{
		Type: "image", MimeType: "image/png", URL: server.URL,
	}}, server.Client())
	if err != ErrPromptImageUnsupported {
		t.Fatalf("materialize error = %v, want ErrPromptImageUnsupported", err)
	}
}

func TestValidateRuntimePromptContentImagesRejectsUnsafeOrAmbiguousURL(t *testing.T) {
	for _, block := range []PromptContentBlock{
		{Type: "image", MimeType: "image/png", URL: "http://bucket.example/image.png"},
		{Type: "image", MimeType: "image/png", URL: "https://user:pass@bucket.example/image.png"},
		{Type: "image", MimeType: "image/png", URL: "https://bucket.example/image.png", Data: "aW1hZ2U="},
	} {
		if err := validateRuntimePromptContentImages([]PromptContentBlock{block}); err != ErrPromptImageUnsupported {
			t.Fatalf("validateRuntimePromptContentImages(%#v) = %v, want ErrPromptImageUnsupported", block, err)
		}
	}
}

func TestPromptContentPreflightAcceptsPathBackedImageBeforeRuntimeHydration(t *testing.T) {
	t.Parallel()

	content := []PromptContentBlock{{
		Type:     "image",
		MimeType: " image/png ",
		Path:     " /managed/agent-prompt-assets/screen.png ",
		Name:     " screen.png ",
	}}
	if err := validatePromptContentImagesForPreflight(content); err != nil {
		t.Fatalf("validatePromptContentImagesForPreflight() error = %v, want nil", err)
	}
	normalized := normalizeRuntimePromptContentForValidation(content)
	if len(normalized) != 1 || normalized[0].Path != "/managed/agent-prompt-assets/screen.png" {
		t.Fatalf("normalized content = %#v, want path-backed image", normalized)
	}
	if err := validateRuntimePromptContentImages(content); !errors.Is(err, ErrPromptImageUnsupported) {
		t.Fatalf("validateRuntimePromptContentImages() error = %v, want ErrPromptImageUnsupported", err)
	}
}

func TestUserPromptActivityPayloadPreservesRemoteURLWithoutInlineData(t *testing.T) {
	signedURL := "https://bucket.example/image.png?token=bearer-secret"
	payload := userPromptActivityPayload([]PromptContentBlock{{Type: "image", MimeType: "image/png", URL: signedURL, Data: "base64-secret", AttachmentID: "attachment-1", Name: "screen.png"}}, "", nil)
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(encoded)
	if !strings.Contains(serialized, signedURL) {
		t.Fatalf("activity payload lost remote image URL: %s", serialized)
	}
	if strings.Contains(serialized, "base64-secret") {
		t.Fatalf("activity payload leaked inline image data: %s", serialized)
	}
	if !strings.Contains(serialized, "attachment-1") || !strings.Contains(serialized, "screen.png") {
		t.Fatalf("activity payload lost safe metadata: %s", serialized)
	}
}

func TestNormalizeRuntimePromptContentAcceptsAttachmentOnlyImage(t *testing.T) {
	t.Parallel()

	content := normalizeRuntimePromptContent([]PromptContentBlock{{
		Type:         "image",
		MimeType:     " image/png ",
		AttachmentID: " attachment-1 ",
		Name:         " screenshot.png ",
	}})

	if len(content) != 1 {
		t.Fatalf("content length = %d, want 1", len(content))
	}
	if content[0].Type != "image" ||
		content[0].MimeType != "image/png" ||
		content[0].AttachmentID != "attachment-1" ||
		content[0].Name != "screenshot.png" {
		t.Fatalf("content[0] = %#v, want normalized attachment-backed image", content[0])
	}
	if content[0].Data != "" {
		t.Fatalf("content[0].Data = %q, want empty", content[0].Data)
	}
}

func TestUserPromptActivityPayloadExtraFromExecMetadataAddsClientSubmitIdentity(t *testing.T) {
	t.Parallel()

	ctx := context.WithValue(context.Background(), execMetadataContextKey{}, map[string]any{
		"clientSubmitId":          "submit-1",
		"clientSubmittedAtUnixMs": int64(1234),
	})
	extra := userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
		"steered": true,
	})

	if extra["clientSubmitId"] != "submit-1" ||
		extra["clientSubmittedAtUnixMs"] != int64(1234) ||
		extra["messageId"] != "client-submit:user:submit-1" ||
		extra["steered"] != true {
		t.Fatalf("extra = %#v, want client submit identity and existing fields", extra)
	}
}

func TestUserPromptActivityPayloadExtraFromExecMetadataPreservesExplicitMessageID(t *testing.T) {
	t.Parallel()

	ctx := context.WithValue(context.Background(), execMetadataContextKey{}, map[string]any{
		"clientSubmitId": "submit-1",
	})
	extra := userPromptActivityPayloadExtraFromExecMetadata(ctx, map[string]any{
		"messageId": "explicit-message-1",
	})

	if extra["messageId"] != "explicit-message-1" || extra["clientSubmitId"] != "submit-1" {
		t.Fatalf("extra = %#v, want explicit messageId preserved", extra)
	}
}

func TestNewUserPromptActivityEventUsesStableTurnMessageID(t *testing.T) {
	t.Parallel()

	session := Session{RoomID: "room-1", AgentSessionID: "agent-1", Provider: ProviderCodex}
	want := newTurnUserPromptActivityMessageID()
	ctx := withPromptActivityMessageID(context.Background(), want)
	first := newUserPromptActivityEvent(ctx, session, textPrompt("hello"), "", "hello", "turn-1", nil)
	second := newUserPromptActivityEvent(ctx, session, textPrompt("hello"), "", "hello", "turn-1", nil)

	if first.EventID != want || second.EventID != want {
		t.Fatalf("event IDs = %q and %q, want %q", first.EventID, second.EventID, want)
	}
	if first.Payload.Metadata["messageId"] != want || second.Payload.Metadata["messageId"] != want {
		t.Fatalf("message IDs = %#v and %#v, want %q", first.Payload.Metadata, second.Payload.Metadata, want)
	}
}

func TestNewUserPromptActivityEventUsesCanonicalPromptContent(t *testing.T) {
	t.Parallel()

	session := Session{RoomID: "room-1", AgentSessionID: "agent-1", Provider: ProviderCodex}
	ctx := withCanonicalPromptContent(context.Background(), textPrompt("user content"))
	event := newUserPromptActivityEvent(ctx, session, textPrompt("provider-only connector instruction"), "", "provider-only connector instruction", "turn-1", nil)

	if event.Payload.Content != "user content" || event.Payload.Metadata["content"].([]map[string]any)[0]["text"] != "user content" {
		t.Fatalf("prompt event = %#v, want canonical user content", event)
	}
}
