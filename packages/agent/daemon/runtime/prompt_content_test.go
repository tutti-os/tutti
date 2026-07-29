package agentruntime

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"
	"time"
)

func textPrompt(text string) []PromptContentBlock {
	return []PromptContentBlock{{Type: "text", Text: text}}
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

type staticProviderPromptImageResolver map[string][]netip.Addr

func (r staticProviderPromptImageResolver) LookupNetIP(_ context.Context, _ string, host string) ([]netip.Addr, error) {
	addresses, ok := r[host]
	if !ok {
		return nil, &net.DNSError{Name: host, Err: "not found"}
	}
	return append([]netip.Addr(nil), addresses...), nil
}

func TestNormalizeRuntimePromptContentPreservesURLOnlyImage(t *testing.T) {
	signedURL := "https://bucket.example/image.webp?token=secret"
	content := normalizeRuntimePromptContent([]PromptContentBlock{{Type: "image", MimeType: " image/webp ", URL: " " + signedURL + " ", Name: " image.webp "}})
	if len(content) != 1 || content[0].URL != signedURL || content[0].Data != "" {
		t.Fatalf("content = %#v, want normalized URL-only image", content)
	}
}

func TestProviderPromptImageAddressPublicRejectsInternalNetworks(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		address string
		want    bool
	}{
		{address: "8.8.8.8", want: true},
		{address: "2606:4700:4700::1111", want: true},
		{address: "0.0.0.1"},
		{address: "127.0.0.1"},
		{address: "10.0.0.1"},
		{address: "100.64.0.1"},
		{address: "169.254.1.1"},
		{address: "192.168.1.1"},
		{address: "198.18.0.1"},
		{address: "240.0.0.1"},
		{address: "::1"},
		{address: "64:ff9b::a00:1"},
		{address: "2002:a00:1::"},
		{address: "fc00::1"},
		{address: "fe80::1"},
	} {
		test := test
		t.Run(test.address, func(t *testing.T) {
			t.Parallel()
			if got := providerPromptImageAddressPublic(netip.MustParseAddr(test.address)); got != test.want {
				t.Fatalf("providerPromptImageAddressPublic(%q) = %v, want %v", test.address, got, test.want)
			}
		})
	}
}

func TestMaterializeProviderPromptImagesRejectsLoopbackLiteral(t *testing.T) {
	t.Parallel()

	var requests int
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests++
	}))
	defer server.Close()

	_, err := materializeProviderPromptImages(context.Background(), []PromptContentBlock{{
		Type: "image", MimeType: "image/png", URL: server.URL + "/image.png",
	}})
	if err == nil {
		t.Fatal("materialize error = nil, want loopback rejection")
	}
	if requests != 0 {
		t.Fatalf("loopback server received %d requests, want 0", requests)
	}
}

func TestMaterializeProviderPromptImagesRejectsRedirectToInternalAddress(t *testing.T) {
	t.Parallel()

	var requests int
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		if request.URL.Path != "/start" {
			t.Fatalf("request path = %q, want /start", request.URL.Path)
		}
		http.Redirect(response, request, "https://private.example/image.png", http.StatusFound)
	}))
	defer server.Close()

	resolver := staticProviderPromptImageResolver{
		"example.com":     {netip.MustParseAddr("8.8.8.8")},
		"private.example": {netip.MustParseAddr("127.0.0.1")},
	}
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	client := newProviderPromptImageHTTPClientWithNetwork(time.Second, resolver, transport)

	_, err := materializeProviderPromptImagesWithClient(context.Background(), []PromptContentBlock{{
		Type: "image", MimeType: "image/png", URL: "https://example.com/start",
	}}, client)
	if err == nil {
		t.Fatal("materialize error = nil, want internal redirect rejection")
	}
	if requests != 1 {
		t.Fatalf("server received %d requests, want only the public request; error = %v", requests, err)
	}
}

func TestMaterializeProviderPromptImagesDoesNotForwardSignedURLReferer(t *testing.T) {
	t.Parallel()

	var requests int
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests++
		switch request.URL.Path {
		case "/start":
			http.Redirect(response, request, "https://redirect.example/image.png", http.StatusFound)
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

	resolver := staticProviderPromptImageResolver{
		"example.com":      {netip.MustParseAddr("8.8.8.8")},
		"redirect.example": {netip.MustParseAddr("1.1.1.1")},
	}
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} // test-only cross-host redirect
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	client := newProviderPromptImageHTTPClientWithNetwork(time.Second, resolver, transport)

	content, err := materializeProviderPromptImagesWithClient(context.Background(), []PromptContentBlock{{
		Type: "image", MimeType: "image/png", URL: "https://example.com/start?X-Amz-Signature=secret",
	}}, client)
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if requests != 2 || len(content) != 1 || content[0].Data != "aGk=" {
		t.Fatalf("requests = %d, content = %#v, want redirected inline image", requests, content)
	}
}

func TestProviderPromptImageHTTPClientKeepsProxyAndPinsConnectTarget(t *testing.T) {
	t.Parallel()

	imageServer := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Host != "example.com" {
			t.Errorf("image Host = %q, want example.com", request.Host)
		}
		response.Header().Set("Content-Type", "image/png")
		_, _ = response.Write([]byte("hi"))
	}))
	defer imageServer.Close()

	for _, testCase := range []struct {
		name     string
		proxyTLS bool
	}{
		{name: "HTTP"},
		{name: "HTTPS", proxyTLS: true},
	} {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			connectTargets := make(chan string, 1)
			proxyServerNames := make(chan string, 1)
			proxy := httptest.NewUnstartedServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.Method != http.MethodConnect {
					http.Error(response, "CONNECT required", http.StatusMethodNotAllowed)
					return
				}
				connectTargets <- request.Host
				downstream, _, err := response.(http.Hijacker).Hijack()
				if err != nil {
					t.Errorf("hijack proxy: %v", err)
					return
				}
				upstream, err := net.Dial("tcp", imageServer.Listener.Addr().String())
				if err != nil {
					_ = downstream.Close()
					t.Errorf("dial image server: %v", err)
					return
				}
				_, _ = io.WriteString(downstream, "HTTP/1.1 200 Connection Established\r\n\r\n")
				go func() {
					_, _ = io.Copy(upstream, downstream)
					_ = upstream.Close()
				}()
				_, _ = io.Copy(downstream, upstream)
				_ = downstream.Close()
			}))
			if testCase.proxyTLS {
				proxy.TLS = &tls.Config{
					GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) {
						proxyServerNames <- hello.ServerName
						return nil, nil
					},
				}
				proxy.StartTLS()
			} else {
				proxy.Start()
			}
			defer proxy.Close()
			proxyURL, err := url.Parse(proxy.URL)
			if err != nil {
				t.Fatal(err)
			}
			proxyAddress := proxy.Listener.Addr().String()
			_, proxyPort, err := net.SplitHostPort(proxyURL.Host)
			if err != nil {
				t.Fatal(err)
			}
			proxyURL.Host = net.JoinHostPort("proxy.example", proxyPort)

			transport := imageServer.Client().Transport.(*http.Transport).Clone()
			transport.Proxy = http.ProxyURL(proxyURL)
			transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, network, proxyAddress)
			}
			if testCase.proxyTLS {
				transport.TLSClientConfig.InsecureSkipVerify = true // test-only proxy and target routing assertion
			}
			client := newProviderPromptImageHTTPClientWithNetwork(time.Second, staticProviderPromptImageResolver{
				"example.com": {netip.MustParseAddr("8.8.8.8")},
			}, transport)

			content, err := materializeProviderPromptImagesWithClient(context.Background(), []PromptContentBlock{{
				Type: "image", MimeType: "image/png", URL: "https://example.com/image.png",
			}}, client)
			if err != nil {
				t.Fatalf("materialize through proxy: %v", err)
			}
			if len(content) != 1 || content[0].Data != "aGk=" {
				t.Fatalf("content = %#v, want inline image", content)
			}
			select {
			case target := <-connectTargets:
				if target != "8.8.8.8:443" {
					t.Fatalf("proxy CONNECT target = %q, want pinned public IP", target)
				}
			case <-time.After(time.Second):
				t.Fatal("proxy received no CONNECT")
			}
			if testCase.proxyTLS {
				select {
				case serverName := <-proxyServerNames:
					if serverName != proxyURL.Hostname() {
						t.Fatalf("proxy TLS server name = %q, want %q", serverName, proxyURL.Hostname())
					}
				case <-time.After(time.Second):
					t.Fatal("proxy received no TLS ClientHello")
				}
			}
		})
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
