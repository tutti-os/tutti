package agentextension

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestDownloadRuntimeBinaryAllowsHTTPSRedirectWithPinnedBytes(t *testing.T) {
	payload := []byte("pinned-native-bytes")
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/redirect":
			http.Redirect(w, request, "/artifact", http.StatusFound)
		case "/artifact":
			_, _ = w.Write(payload)
		default:
			http.NotFound(w, request)
		}
	}))
	defer server.Close()
	destination := filepath.Join(t.TempDir(), "runtime")
	artifact := testRuntimeBinaryArtifact(server.URL+"/redirect", payload, int64(len(payload)))

	fingerprint, err := downloadRuntimeBinary(context.Background(), server.Client(), artifact, destination)
	if err != nil {
		t.Fatal(err)
	}
	if fingerprint != (runtimeExecutableFingerprint{SHA256: artifact.SHA256, Size: artifact.SizeBytes}) {
		t.Fatalf("download fingerprint = %#v", fingerprint)
	}
	info, err := os.Lstat(destination)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		t.Fatalf("downloaded executable mode = %v, error = %v", info, err)
	}
}

func TestDownloadRuntimeBinaryRejectsHTTPSDowngradeRedirect(t *testing.T) {
	payload := []byte("untrusted")
	insecure := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(payload)
	}))
	defer insecure.Close()
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		http.Redirect(w, request, insecure.URL+"/artifact", http.StatusFound)
	}))
	defer secure.Close()
	destination := filepath.Join(t.TempDir(), "runtime")
	artifact := testRuntimeBinaryArtifact(secure.URL, payload, int64(len(payload)))

	_, err := downloadRuntimeBinary(context.Background(), secure.Client(), artifact, destination)
	if err == nil || !strings.Contains(err.Error(), "redirected away from HTTPS") {
		t.Fatalf("HTTPS downgrade error = %v", err)
	}
	assertPathDoesNotExist(t, destination)
}

func TestDownloadRuntimeBinaryRejectsIntermediateHTTPSDowngradeRedirect(t *testing.T) {
	payload := []byte("untrusted")
	var secure *httptest.Server
	insecure := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		http.Redirect(w, request, secure.URL+"/artifact", http.StatusFound)
	}))
	defer insecure.Close()
	secure = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/redirect":
			http.Redirect(w, request, insecure.URL+"/redirect", http.StatusFound)
		case "/artifact":
			_, _ = w.Write(payload)
		default:
			http.NotFound(w, request)
		}
	}))
	defer secure.Close()
	destination := filepath.Join(t.TempDir(), "runtime")
	artifact := testRuntimeBinaryArtifact(secure.URL+"/redirect", payload, int64(len(payload)))

	_, err := downloadRuntimeBinary(context.Background(), secure.Client(), artifact, destination)
	if err == nil || !strings.Contains(err.Error(), "redirected away from HTTPS") {
		t.Fatalf("intermediate HTTPS downgrade error = %v", err)
	}
	assertPathDoesNotExist(t, destination)
}

func TestDownloadRuntimeBinaryRejectsMismatchedContentLength(t *testing.T) {
	payload := []byte("short")
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(payload)+10))
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	}))
	defer server.Close()
	destination := filepath.Join(t.TempDir(), "runtime")
	artifact := testRuntimeBinaryArtifact(server.URL, payload, int64(len(payload)))

	_, err := downloadRuntimeBinary(context.Background(), server.Client(), artifact, destination)
	if err == nil || !strings.Contains(err.Error(), "Content-Length") {
		t.Fatalf("Content-Length mismatch error = %v", err)
	}
	assertPathDoesNotExist(t, destination)
}

func TestDownloadRuntimeBinaryRejectsStreamedSizeMismatch(t *testing.T) {
	for _, test := range []struct {
		name         string
		payload      []byte
		expectedSize int64
	}{
		{name: "under-size", payload: []byte("under"), expectedSize: 6},
		{name: "over-size", payload: []byte("overrun"), expectedSize: 6},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
				w.(http.Flusher).Flush()
				_, _ = w.Write(test.payload)
			}))
			defer server.Close()
			destination := filepath.Join(t.TempDir(), "runtime")
			artifact := testRuntimeBinaryArtifact(server.URL, test.payload, test.expectedSize)

			_, err := downloadRuntimeBinary(context.Background(), server.Client(), artifact, destination)
			if err == nil || !strings.Contains(err.Error(), "size does not match") {
				t.Fatalf("streamed size mismatch error = %v", err)
			}
			assertPathDoesNotExist(t, destination)
		})
	}
}

func testRuntimeBinaryArtifact(rawURL string, payload []byte, size int64) RuntimeBinaryArtifact {
	artifact := RuntimeBinaryArtifact{
		Kind: "executable", Platform: runtimePlatform(), Version: "0.2.103",
		URL: rawURL, SHA256: sha256Bytes(payload), SizeBytes: size,
	}
	artifact.Provenance.Kind = "official-release"
	artifact.Provenance.URL = "https://example.com/releases/0.2.103"
	return artifact
}

func assertPathDoesNotExist(t *testing.T, path string) {
	t.Helper()
	_, err := os.Lstat(path)
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("path %q remains after failed download: %v", path, err)
	}
}
