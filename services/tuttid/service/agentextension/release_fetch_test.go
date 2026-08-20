package agentextension

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
)

func TestReleaseDownloadsRejectIntermediateHTTPSDowngradeRedirect(t *testing.T) {
	for _, test := range []struct {
		name     string
		payload  string
		download func(*Manager, string) error
	}{
		{
			name:    "release metadata",
			payload: `{"schemaVersion":"test"}`,
			download: func(manager *Manager, rawURL string) error {
				var target map[string]any
				return manager.getJSON(context.Background(), rawURL, 1024, &target)
			},
		},
		{
			name:    "release artifact",
			payload: "artifact bytes",
			download: func(manager *Manager, rawURL string) error {
				_, err := manager.getBytes(context.Background(), rawURL, 1024)
				return err
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var secure *httptest.Server
			insecure := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				http.Redirect(w, request, secure.URL+"/final", http.StatusFound)
			}))
			defer insecure.Close()
			secure = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				switch request.URL.Path {
				case "/redirect":
					http.Redirect(w, request, insecure.URL+"/redirect", http.StatusFound)
				case "/final":
					_, _ = w.Write([]byte(test.payload))
				default:
					http.NotFound(w, request)
				}
			}))
			defer secure.Close()

			manager := &Manager{Client: secure.Client()}
			err := test.download(manager, secure.URL+"/redirect")
			if err == nil || !strings.Contains(err.Error(), "redirected away from HTTPS") {
				t.Fatalf("intermediate HTTPS downgrade error = %v", err)
			}
		})
	}
}

func TestReleaseDownloadsPreserveConfiguredRedirectPolicy(t *testing.T) {
	policyError := errors.New("configured redirect policy")
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/redirect" {
			http.Redirect(w, request, "/final", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("release"))
	}))
	defer server.Close()
	client := server.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return policyError }
	manager := &Manager{Client: client}

	_, err := manager.getBytes(context.Background(), server.URL+"/redirect", 1024)
	if !errors.Is(err, policyError) {
		t.Fatalf("configured redirect policy error = %v", err)
	}
}

func TestReleaseDownloadsRejectConfiguredRedirectPolicyHTTPSDowngrade(t *testing.T) {
	insecureRequests := 0
	insecure := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		insecureRequests++
		_, _ = w.Write([]byte("insecure release"))
	}))
	defer insecure.Close()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		http.Redirect(w, request, "/final", http.StatusFound)
	}))
	defer server.Close()
	client := server.Client()
	client.CheckRedirect = func(request *http.Request, _ []*http.Request) error {
		replacement, err := http.NewRequest(http.MethodGet, insecure.URL, nil)
		if err != nil {
			t.Fatalf("create insecure replacement request: %v", err)
		}
		request.URL = replacement.URL
		return nil
	}
	manager := &Manager{Client: client}

	_, err := manager.getBytes(context.Background(), server.URL, 1024)
	if err == nil || !strings.Contains(err.Error(), "redirected away from HTTPS") {
		t.Fatalf("configured redirect policy downgrade error = %v", err)
	}
	if insecureRequests != 0 {
		t.Fatalf("insecure redirect target received %d requests", insecureRequests)
	}
}

func TestVerifyReleasePreservesSignedOptionalManifestFields(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	document := map[string]any{
		"schemaVersion":     releaseSchema,
		"agentKey":          "grok",
		"version":           "0.1.2",
		"artifactUrl":       "https://example.test/grok-0.1.2.zip",
		"artifactSha256":    "abc",
		"artifactSizeBytes": 1,
		"publishedAt":       "2026-07-21T00:00:00Z",
		"gitSha":            "test",
		"manifest": map[string]any{
			"schemaVersion": "tutti.agent.manifest.v2",
			"agentKey":      "grok",
			"version":       "0.1.2",
			"name":          "Grok Build",
			"icon":          map[string]any{"type": "asset", "src": "assets/icon.svg"},
			"runtime": map[string]any{
				"kind":    "standard-acp",
				"install": map[string]any{"runner": "binary"},
				"launch":  map[string]any{"executable": "grok", "args": []string{"agent", "stdio"}},
			},
			"profiles": map[string]any{"discovery": "profiles/discovery.json"},
		},
		"signature": map[string]any{
			"algorithm": "ed25519",
			"keyId":     "test-grok-key",
			"value":     "",
		},
	}
	payload, err := releasePayloadFromJSON(mustJSON(t, document))
	if err != nil {
		t.Fatal(err)
	}
	document["signature"].(map[string]any)["value"] = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, payload))

	var release Release
	if err := json.Unmarshal(mustJSON(t, document), &release); err != nil {
		t.Fatal(err)
	}
	source := tuttitypes.AgentExtensionSource{
		Key: "grok", SigningKeyID: "test-grok-key", SigningPublicKey: publicKeyPEM(t, publicKey),
	}
	if err := verifyRelease(release, source); err != nil {
		t.Fatalf("verifyRelease() error = %v", err)
	}

	path := filepath.Join(t.TempDir(), "release.json")
	if err := writeJSONAtomic(path, release); err != nil {
		t.Fatal(err)
	}
	var persisted Release
	if err := readJSON(path, &persisted); err != nil {
		t.Fatal(err)
	}
	if err := verifyRelease(persisted, source); err != nil {
		t.Fatalf("verifyRelease() after persistence error = %v", err)
	}
}

func TestSelectVersionUsesClientPinnedRelease(t *testing.T) {
	document := Versions{
		SchemaVersion: versionsSchema,
		AgentKey:      "gemini",
		Versions: []VersionRecord{
			{Version: "2.0.0", MinTuttiVersion: "0.2.0", Status: "active"},
			{Version: "1.0.0", MinTuttiVersion: "0.1.0", Status: "active", Release: Release{Version: "1.0.0"}},
		},
	}

	record, err := selectVersion(document, "gemini", "0.3.0", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if record.Version != "1.0.0" {
		t.Fatalf("selected version = %q, want client pin 1.0.0", record.Version)
	}
}

func TestSelectVersionRejectsUnavailableClientPin(t *testing.T) {
	base := Versions{
		SchemaVersion: versionsSchema,
		AgentKey:      "gemini",
		Versions:      []VersionRecord{{Version: "1.0.0", MinTuttiVersion: "0.2.0", Status: "active"}},
	}
	tests := []struct {
		name       string
		document   Versions
		appVersion string
		pin        string
		want       string
	}{
		{name: "missing pin", document: base, appVersion: "0.3.0", pin: "2.0.0", want: "missing"},
		{name: "invalid pin", document: base, appVersion: "0.3.0", pin: "latest", want: "pin is invalid"},
		{name: "old client", document: base, appVersion: "0.1.0", pin: "1.0.0", want: "not active or compatible"},
		{name: "inactive", document: Versions{SchemaVersion: versionsSchema, AgentKey: "gemini", Versions: []VersionRecord{{Version: "1.0.0", MinTuttiVersion: "0.0.0", Status: "withdrawn"}}}, appVersion: "0.3.0", pin: "1.0.0", want: "not active or compatible"},
		{name: "unsupported capabilities", document: Versions{SchemaVersion: versionsSchema, AgentKey: "gemini", Versions: []VersionRecord{{Version: "1.0.0", MinTuttiVersion: "0.0.0", Status: "active", RequiredHostCapabilities: []string{"future"}}}}, appVersion: "0.3.0", pin: "1.0.0", want: "not active or compatible"},
		{name: "mismatched release identity", document: Versions{SchemaVersion: versionsSchema, AgentKey: "gemini", Versions: []VersionRecord{{Version: "1.0.0", MinTuttiVersion: "0.0.0", Status: "active", Release: Release{Version: "2.0.0"}}}}, appVersion: "0.3.0", pin: "1.0.0", want: "release identity"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := selectVersion(test.document, "gemini", test.appVersion, test.pin)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("selectVersion() error = %v, want %q", err, test.want)
			}
		})
	}
}
