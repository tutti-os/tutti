package artifact

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	connectorhost "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

func TestDirectFetcherDownloadsMarketArtifactDirectly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/artifacts/connectors/github/1.0.0.zip" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		writer.Header().Set("Content-Type", "application/zip")
		writer.Header().Set("Content-Length", "3")
		_, _ = writer.Write([]byte("zip"))
	}))
	defer server.Close()

	fetcher, err := NewDirectFetcher(DirectFetcherConfig{BaseURL: server.URL + "/artifacts/", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	release := directFetcherTestRelease()
	release.Artifact.Key = "connectors/github/1.0.0.zip"
	response, err := fetcher.Fetch(context.Background(), FetchRequest{
		Release: release,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	content, _ := io.ReadAll(response.Body)
	if string(content) != "zip" || response.ContentLength != 3 || response.MediaType != "application/zip" {
		t.Fatalf("response = %#v content=%q", response, content)
	}
}

func TestDirectFetcherRejectsUnsafeArtifactKey(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	fetcher, err := NewDirectFetcher(DirectFetcherConfig{BaseURL: server.URL + "/connectors/", HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	release := directFetcherTestRelease()
	release.Artifact.Key = "../secrets.zip"
	_, err = fetcher.Fetch(context.Background(), FetchRequest{Release: release})
	if err == nil || !strings.Contains(err.Error(), "key is invalid") {
		t.Fatalf("error = %v", err)
	}
}

func TestDirectFetcherRequiresHostHTTPClient(t *testing.T) {
	_, err := NewDirectFetcher(DirectFetcherConfig{BaseURL: "https://artifacts.example.test/connectors/"})
	if err == nil || !strings.Contains(err.Error(), "HTTP client") {
		t.Fatalf("expected missing HTTP client error, got %v", err)
	}
}

func TestDirectFetcherRejectsCrossOriginRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, "https://other.example.test/artifact.zip", http.StatusFound)
	}))
	defer server.Close()
	fetcher, err := NewDirectFetcher(DirectFetcherConfig{BaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	_, err = fetcher.Fetch(context.Background(), FetchRequest{Release: directFetcherTestRelease()})
	if err == nil || !strings.Contains(err.Error(), "configured origin") {
		t.Fatalf("error = %v", err)
	}
}

func directFetcherTestRelease() connectorhost.Release {
	return connectorhost.Release{
		ConnectorKey:  "github",
		Version:       "1.0.0",
		ReleaseDigest: strings.Repeat("a", 64),
		Artifact: connectorhost.Artifact{
			Key:       "connectors/github/1.0.0.zip",
			SHA256:    strings.Repeat("b", 64),
			SizeBytes: 3,
			MediaType: "application/zip",
		},
		PublishedAt: time.Unix(1, 0).UTC(),
	}
}
