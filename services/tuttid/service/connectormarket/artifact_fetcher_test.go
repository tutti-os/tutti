package connectormarket

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	marketartifact "github.com/tutti-os/tutti/packages/connector/market/artifact"
)

func TestDirectArtifactFetcherDownloadsMarketArtifactDirectly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/artifacts/connectors/github/1.0.0.zip" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		writer.Header().Set("Content-Type", "application/zip")
		writer.Header().Set("Content-Length", "3")
		_, _ = writer.Write([]byte("zip"))
	}))
	defer server.Close()

	fetcher, err := NewDirectArtifactFetcher(DirectArtifactFetcherConfig{BaseURL: server.URL + "/artifacts/"})
	if err != nil {
		t.Fatal(err)
	}
	release := catalogTestRelease()
	release.Artifact.Key = "connectors/github/1.0.0.zip"
	response, err := fetcher.Fetch(context.Background(), marketartifact.FetchRequest{
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

func TestDirectArtifactFetcherRejectsUnsafeArtifactKey(t *testing.T) {
	fetcher, err := NewDirectArtifactFetcher(DirectArtifactFetcherConfig{BaseURL: "https://artifacts.example.test/connectors/"})
	if err != nil {
		t.Fatal(err)
	}
	release := catalogTestRelease()
	release.Artifact.Key = "../secrets.zip"
	_, err = fetcher.Fetch(context.Background(), marketartifact.FetchRequest{Release: release})
	if err == nil || !strings.Contains(err.Error(), "key is invalid") {
		t.Fatalf("error = %v", err)
	}
}

func TestDirectArtifactFetcherRejectsCrossOriginRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, "https://other.example.test/artifact.zip", http.StatusFound)
	}))
	defer server.Close()
	fetcher, err := NewDirectArtifactFetcher(DirectArtifactFetcherConfig{BaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, err = fetcher.Fetch(context.Background(), marketartifact.FetchRequest{Release: catalogTestRelease()})
	if err == nil || !strings.Contains(err.Error(), "configured origin") {
		t.Fatalf("error = %v", err)
	}
}
