package globalagentactivity

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
)

type accountSessionStub struct {
	session *authbridge.Session
	err     error
}

func (s accountSessionStub) ReadSession() (*authbridge.Session, error) {
	return s.session, s.err
}

func TestServiceReadsEachRequestWithTheCurrentAccountSession(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requestCount++
		if got := request.Header.Get("Cookie"); got != "session=current" {
			t.Fatalf("cookie = %q", got)
		}
		if got := request.Header.Get("X-User-Id"); got != "user-1" {
			t.Fatalf("user id = %q", got)
		}
		if request.URL.Path == "/v2/agent-activity/filter-options" {
			_, _ = w.Write([]byte(`{"rooms":[],"sessionOwners":[],"agents":[],"timeBounds":{}}`))
			return
		}
		_, _ = w.Write([]byte(`{"items":[],"truncated":false}`))
	}))
	defer server.Close()

	service := &Service{
		Account: accountSessionStub{session: &authbridge.Session{
			Cookie: "session=current",
			UserID: "user-1",
		}},
		BaseURL:    server.URL,
		HTTPClient: server.Client(),
	}
	if _, err := service.FilterOptions(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ListSessions(context.Background(), agentsessionstore.ListGlobalAgentActivitySessionsInput{RoomIDs: []string{"room-1"}}); err != nil {
		t.Fatal(err)
	}
	if requestCount != 2 {
		t.Fatalf("request count = %d", requestCount)
	}
}

func TestServiceRejectsMissingAccountSession(t *testing.T) {
	service := &Service{Account: accountSessionStub{}}
	if _, err := service.FilterOptions(context.Background()); err != ErrUnauthenticated {
		t.Fatalf("error = %v", err)
	}
}
