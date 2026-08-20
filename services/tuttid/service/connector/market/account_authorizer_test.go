package connectormarket

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestAccountSessionAuthorizerLoadsCurrentCookiePerRequest(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(`{"session_id":"session-1","cookie":"sid=secret"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	authorizer, err := NewAccountSessionAuthorizer(path, "  ppe-connectors  ")
	if err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest(http.MethodGet, "https://example.test", nil)
	if err := authorizer.Authorize(request); err != nil {
		t.Fatal(err)
	}
	if request.Header.Get("Cookie") != "sid=secret" {
		t.Fatalf("cookie = %q", request.Header.Get("Cookie"))
	}
	if request.Header.Get("x-zk-ppe-lane") != "ppe-connectors" {
		t.Fatalf("ppe lane = %q", request.Header.Get("x-zk-ppe-lane"))
	}
}

func TestAccountSessionAuthorizerFailsClosedWithoutSession(t *testing.T) {
	authorizer, err := NewAccountSessionAuthorizer(filepath.Join(t.TempDir(), "missing.json"), "")
	if err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest(http.MethodGet, "https://example.test", nil)
	if err := authorizer.Authorize(request); err == nil {
		t.Fatal("expected missing account session to fail")
	}
}

func TestAccountSessionAuthorizerFencesAccountSwitch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.json")
	if err := os.WriteFile(path, []byte(`{"session_id":"session-1","cookie":"sid=secret","user_id":"account-2"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	authorizer, err := NewAccountSessionAuthorizer(path, "")
	if err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest(http.MethodGet, "https://example.test", nil)
	if err := authorizer.AuthorizeForAccount(request, "account-1"); err == nil || request.Header.Get("Cookie") != "" {
		t.Fatalf("account switch authorization error=%v cookie=%q", err, request.Header.Get("Cookie"))
	}
}
