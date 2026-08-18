package marketclient

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	marketv1 "github.com/tutti-os/tutti/packages/clients/market-go/generated/sandbox/v1"
)

func TestGeneratedClientPreservesGatewayPathQueryAndCategoryFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/desktop/v1/market/categories" {
			t.Fatalf("path = %q", request.URL.Path)
		}
		if request.URL.Query().Get("itemType") != "skill" {
			t.Fatalf("query = %q", request.URL.RawQuery)
		}
		if request.Header.Get("Authorization") != "Bearer market-token" {
			t.Fatalf("authorization = %q", request.Header.Get("Authorization"))
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
  "marketType": "overseas",
  "categories": [{
    "categoryId": "business-operations",
    "kind": "category",
    "sortOrder": 60,
    "itemCount": "9",
    "displayNameZh": "商业与运营",
    "displayNameEn": "Business & Operations",
    "additiveField": true
  }]
}`))
	}))
	defer server.Close()

	client, err := New(Config{
		BaseURL:    server.URL + "/api/desktop",
		HTTPClient: server.Client(),
		PrepareRequest: func(request *http.Request) error {
			request.Header.Set("Authorization", "Bearer market-token")
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	reply, err := client.ListMarketCategories(context.Background(), &marketv1.ListMarketCategoriesRequest{ItemType: "skill"})
	if err != nil {
		t.Fatal(err)
	}
	if reply.GetMarketType() != "overseas" || len(reply.GetCategories()) != 1 {
		t.Fatalf("reply = %+v", reply)
	}
	category := reply.GetCategories()[0]
	if category.GetCategoryId() != "business-operations" || category.GetItemCount() != 9 ||
		category.GetDisplayNameZh() != "商业与运营" || category.GetDisplayNameEn() != "Business & Operations" {
		t.Fatalf("category = %+v", category)
	}
}

func TestGeneratedClientPreservesOpaqueSectionID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/market/items" || request.URL.Query().Get("sectionId") != "developer-tools" {
			t.Fatalf("request = %s?%s", request.URL.Path, request.URL.RawQuery)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"marketType":"overseas","items":[],"nextPageToken":""}`))
	}))
	defer server.Close()

	client, err := New(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ListMarketItems(context.Background(), &marketv1.ListMarketItemsRequest{
		ItemType: "connector", SectionId: "developer-tools", PageSize: 20,
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestGeneratedClientRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(strings.Repeat(" ", MaxResponseBodyBytes+1)))
	}))
	defer server.Close()

	client, err := New(Config{BaseURL: server.URL, HTTPClient: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ListMarketCategories(context.Background(), &marketv1.ListMarketCategoriesRequest{ItemType: "connector"})
	if err == nil || !strings.Contains(err.Error(), "size limit") {
		t.Fatalf("error = %v", err)
	}
}

func TestGeneratedClientRejectsRedirectOutsideConfiguredOriginBeforeReauthorizing(t *testing.T) {
	var authorizationCalls atomic.Int32
	var redirectedCalls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		redirectedCalls.Add(1)
	}))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Location", target.URL)
		response.WriteHeader(http.StatusFound)
	}))
	defer source.Close()

	client, err := New(Config{
		BaseURL:    source.URL,
		HTTPClient: source.Client(),
		PrepareRequest: func(request *http.Request) error {
			authorizationCalls.Add(1)
			request.Header.Set("Cookie", "session=market-secret")
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ListMarketCategories(context.Background(), &marketv1.ListMarketCategoriesRequest{ItemType: "connector"})
	if err == nil || !strings.Contains(err.Error(), "configured origin") {
		t.Fatalf("error = %v", err)
	}
	if authorizationCalls.Load() != 1 {
		t.Fatalf("authorization calls = %d", authorizationCalls.Load())
	}
	if redirectedCalls.Load() != 0 {
		t.Fatalf("redirected calls = %d", redirectedCalls.Load())
	}
}

func TestGeneratedClientPreservesHostRedirectPolicy(t *testing.T) {
	policyError := errors.New("redirect blocked by host")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Location", "/redirected")
		response.WriteHeader(http.StatusFound)
	}))
	defer server.Close()
	httpClient := server.Client()
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error {
		return policyError
	}

	client, err := New(Config{BaseURL: server.URL, HTTPClient: httpClient})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ListMarketCategories(context.Background(), &marketv1.ListMarketCategoriesRequest{ItemType: "connector"})
	if !errors.Is(err, policyError) {
		t.Fatalf("error = %v", err)
	}
}

func TestGeneratedClientFollowsSameOriginRedirectWithoutReauthorizing(t *testing.T) {
	var authorizationCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v1/market/categories" {
			response.Header().Set("Location", "/redirected")
			response.WriteHeader(http.StatusFound)
			return
		}
		if request.URL.Path != "/redirected" || request.Header.Get("Cookie") != "session=market-secret" {
			t.Fatalf("redirected request = %s cookie %q", request.URL.Path, request.Header.Get("Cookie"))
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"marketType":"overseas","categories":[]}`))
	}))
	defer server.Close()

	client, err := New(Config{
		BaseURL:    server.URL,
		HTTPClient: server.Client(),
		PrepareRequest: func(request *http.Request) error {
			authorizationCalls.Add(1)
			request.Header.Set("Cookie", "session=market-secret")
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ListMarketCategories(context.Background(), &marketv1.ListMarketCategoriesRequest{ItemType: "connector"})
	if err != nil {
		t.Fatal(err)
	}
	if authorizationCalls.Load() != 1 {
		t.Fatalf("authorization calls = %d", authorizationCalls.Load())
	}
}

func TestGeneratedClientRejectsHTTPSDowngradeBeforeReauthorizing(t *testing.T) {
	var authorizationCalls atomic.Int32
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Location", "http"+strings.TrimPrefix(server.URL, "https")+"/redirected")
		response.WriteHeader(http.StatusFound)
	}))
	defer server.Close()

	client, err := New(Config{
		BaseURL:    server.URL,
		HTTPClient: server.Client(),
		PrepareRequest: func(request *http.Request) error {
			authorizationCalls.Add(1)
			request.Header.Set("Cookie", "session=market-secret")
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ListMarketCategories(context.Background(), &marketv1.ListMarketCategoriesRequest{ItemType: "connector"})
	if err == nil || !strings.Contains(err.Error(), "configured origin") {
		t.Fatalf("error = %v", err)
	}
	if authorizationCalls.Load() != 1 {
		t.Fatalf("authorization calls = %d", authorizationCalls.Load())
	}
}

func TestGeneratedClientRejectsInvalidConfig(t *testing.T) {
	if _, err := New(Config{BaseURL: "http://example.com", HTTPClient: http.DefaultClient}); err == nil {
		t.Fatal("expected insecure base URL error")
	}
	if _, err := New(Config{BaseURL: "https://example.com"}); err == nil {
		t.Fatal("expected missing HTTP client error")
	}
}
