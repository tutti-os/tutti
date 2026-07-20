package agentextension

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
