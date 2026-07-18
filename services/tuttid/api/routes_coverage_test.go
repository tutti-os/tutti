package api

import (
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

type recordingServeMux struct {
	patterns []string
}

func (m *recordingServeMux) HandleFunc(pattern string, _ func(http.ResponseWriter, *http.Request)) {
	m.patterns = append(m.patterns, pattern)
}

func (m *recordingServeMux) ServeHTTP(http.ResponseWriter, *http.Request) {}

// coverageStubRoutes satisfies Routes for registration only; no handler is
// ever invoked, so the embedded nil ServerInterface is never dereferenced.
type coverageStubRoutes struct {
	tuttigenerated.ServerInterface
}

func (coverageStubRoutes) AttachEventStreamWebSocket(http.ResponseWriter, *http.Request)       {}
func (coverageStubRoutes) AttachWorkspaceTerminalWebSocket(http.ResponseWriter, *http.Request) {}
func (coverageStubRoutes) HandleManagedModelGrant(http.ResponseWriter, *http.Request, string, string, string) {
}
func (coverageStubRoutes) HandleManagedModelGrantCredential(http.ResponseWriter, *http.Request, string, string, string) {
}
func (coverageStubRoutes) HandleManagedModelGrantExchange(http.ResponseWriter, *http.Request, string, string) {
}
func (coverageStubRoutes) HandleManagedModelGrantModels(http.ResponseWriter, *http.Request, string, string, string) {
}
func (coverageStubRoutes) HandleManagedModelGrants(http.ResponseWriter, *http.Request, string, string) {
}
func (coverageStubRoutes) HandleManagedModelProvider(http.ResponseWriter, *http.Request, string, string) {
}
func (coverageStubRoutes) HandleManagedModelProviderModels(http.ResponseWriter, *http.Request, string, string) {
}
func (coverageStubRoutes) HandleManagedModelProviderTest(http.ResponseWriter, *http.Request, string, string) {
}
func (coverageStubRoutes) HandleManagedModelProviders(http.ResponseWriter, *http.Request, string) {
}

// RegisterRoutes wires generated handlers into the daemon mux by hand, route
// by route. A route that exists in the generated OpenAPI surface but is never
// registered silently 404s in production while every generated client calls
// it as if it existed (the Stop control shipped exactly that way). This guard
// resolves every generated route pattern against the real mux so the gap is
// caught at test time instead of by a user.
func TestRegisterRoutesCoversEveryGeneratedRoute(t *testing.T) {
	recorder := &recordingServeMux{}
	tuttigenerated.HandlerWithOptions(
		coverageStubRoutes{},
		tuttigenerated.StdHTTPServerOptions{BaseRouter: recorder},
	)
	if len(recorder.patterns) == 0 {
		t.Fatal("no generated routes recorded")
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, coverageStubRoutes{})

	pathParams := regexp.MustCompile(`\{[^}]+\}`)
	for _, pattern := range recorder.patterns {
		method, path, ok := strings.Cut(pattern, " ")
		if !ok {
			t.Fatalf("generated pattern %q has no method prefix", pattern)
		}
		concrete := pathParams.ReplaceAllString(path, "x")
		request := httptest.NewRequest(method, concrete, nil)
		if _, matched := mux.Handler(request); matched == "" {
			t.Errorf("generated route %q is not registered on the daemon mux", pattern)
		}
	}
}
