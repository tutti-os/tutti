package connectormarket

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	market "github.com/tutti-os/tutti/packages/connector/market/daemon"
)

func TestCatalogSourceMapsPublishedConnectorItems(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("itemType") != "connector" || request.Header.Get("Authorization") != "Bearer catalog-token" {
			t.Fatalf("request path=%q query=%q authorization=%q", request.URL.Path, request.URL.RawQuery, request.Header.Get("Authorization"))
		}
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path == connectorCategoriesPath {
			_, _ = writer.Write([]byte(`{
  "marketType": "overseas",
  "categories": [
    {"categoryId": "featured", "kind": "featured", "sortOrder": 10, "itemCount": "1"},
    {"categoryId": "development", "kind": "category", "sortOrder": 20, "itemCount": "1"}
  ]
}`))
			return
		}
		if request.URL.Path != connectorCatalogPath || request.URL.Query().Get("sectionId") != "development" || request.URL.Query().Get("pageSize") != "100" {
			t.Fatalf("request path=%q query=%q", request.URL.Path, request.URL.RawQuery)
		}
		_, _ = writer.Write([]byte(`{
  "marketType": "overseas",
  "items": [{
    "itemType": "connector",
    "itemKey": "github",
    "version": "1.0.0",
    "commitSha": "0123456789abcdef",
    "artifact": {
      "key": "connectors/github/1.0.0.zip",
      "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "sizeBytes": "123"
    },
    "manifest": {
      "schemaVersion": "1",
      "itemType": "connector",
      "itemKey": "github",
      "version": "1.0.0",
      "display": {"name": "GitHub", "description": "GitHub connector"},
      "supportedMarkets": ["overseas"],
      "payload": {
        "permissions": ["repository.read"],
        "packageManifestSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "authorization": {"kind": "none"},
        "compatibility": {},
        "implementations": {
          "overseas": {
            "kind": "managed_stdio",
            "managedStdio": {
              "runtime": {"language": "node", "profile": "connector-node-static", "abi": "node20-darwin-arm64"},
              "mcp": {"entrypoint": "bin/github.js"}
            }
          }
        }
      }
    },
    "publishedAtMs": "1785801600000",
    "categoryId": "development",
    "featured": true
  }],
  "nextPageToken": ""
}`))
	}))
	defer server.Close()

	source, err := NewCatalogSource(CatalogSourceConfig{
		BaseURL:            server.URL,
		ExpectedMarketType: "overseas",
		AuthorizeRequest: func(request *http.Request) error {
			request.Header.Set("Authorization", "Bearer catalog-token")
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := source.Refresh(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Releases) != 1 || result.SourceRevision == "" {
		t.Fatalf("snapshot = %#v", result)
	}
	got := result.Releases[0]
	if got.ConnectorKey != "github" || got.ReleaseID != "github@1.0.0" || got.ManifestDigest != "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" || got.Artifact.SizeBytes != 123 || got.Artifact.MediaType != "application/zip" || got.Manifest.Implementation.ManagedStdio == nil {
		t.Fatalf("release = %#v", got)
	}
}

func TestCatalogSourceRejectsInvalidConfiguration(t *testing.T) {
	if _, err := NewCatalogSource(CatalogSourceConfig{BaseURL: "/market", ExpectedMarketType: "overseas"}); err == nil {
		t.Fatal("expected invalid URL")
	}
	if _, err := NewCatalogSource(CatalogSourceConfig{BaseURL: "https://example.test", ExpectedMarketType: "invalid"}); err == nil {
		t.Fatal("expected invalid market type")
	}
}

func TestCatalogSourcePreservesGatewayBasePath(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/desktop/v1/market/categories" {
			t.Fatalf("request path = %q", request.URL.Path)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"marketType":"overseas","categories":[]}`))
	}))
	defer server.Close()

	source, err := NewCatalogSource(CatalogSourceConfig{
		BaseURL:            server.URL + "/api/desktop",
		ExpectedMarketType: "overseas",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := source.ListCategories(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestCatalogSourceRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte(strings.Repeat(" ", maxCatalogResponseBytes+1)))
	}))
	defer server.Close()
	source, err := NewCatalogSource(CatalogSourceConfig{BaseURL: server.URL, ExpectedMarketType: "overseas"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := source.Refresh(context.Background()); err == nil || !strings.Contains(err.Error(), "size limit") {
		t.Fatalf("error = %v", err)
	}
}

func catalogTestRelease() market.Release {
	return market.Release{
		SchemaVersion:  "1",
		ReleaseID:      "github@1.0.0",
		ConnectorKey:   "github",
		Version:        "1.0.0",
		ReleaseDigest:  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ManifestDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		Manifest: market.Manifest{
			SchemaVersion:     "1",
			DisplayName:       "GitHub",
			Permissions:       []string{"repository.read"},
			AuthorizationKind: "none",
			Implementation: market.Implementation{
				Kind: market.ImplementationKindManagedStdio,
				ManagedStdio: &market.ManagedStdioImplementation{
					Runtime: market.RuntimeRequirement{Language: "node", Profile: "connector-node-static", ABI: "node20-darwin-arm64"},
					MCP:     &market.ManagedMCPInterface{Entrypoint: "bin/github.js"},
				},
			},
		},
		Artifact: market.Artifact{
			Key:       "connectors/github/1.0.0.zip",
			SHA256:    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			SizeBytes: 123,
			MediaType: "application/zip",
		},
		PublishedAt: time.Date(2026, 8, 4, 0, 0, 0, 0, time.UTC),
		Status:      market.ReleaseStatusAvailable,
	}
}
