package userpresence

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
)

type fixedAccountSession struct{ cookie string }

func (session fixedAccountSession) ReadSession() (*authbridge.Session, error) {
	return &authbridge.Session{Cookie: session.cookie}, nil
}

func TestHTTPControlPlaneReadsVersionedSnapshot(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/device-presence/users/batch-get" || request.Header.Get("Cookie") != "sid=test" {
			t.Errorf("request = %s headers=%#v", request.URL.Path, request.Header)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{
          "presenceAvailability":"DEVICE_PRESENCE_AVAILABILITY_AVAILABLE",
          "authorityGeneration":"authority-1",
          "users":[{"userId":"user-1","status":"DEVICE_PRESENCE_STATUS_ONLINE","presenceRevision":"42","observedAt":"2026-08-24T00:00:00Z"}]
        }`))
	}))
	defer server.Close()
	client := &HTTPControlPlane{BaseURL: server.URL, Account: fixedAccountSession{cookie: "sid=test"}}
	snapshot, err := client.BatchGetUserPresence(context.Background(), []string{"user-1"})
	if err != nil {
		t.Fatal(err)
	}
	if !snapshot.Available || snapshot.AuthorityGeneration != "authority-1" || len(snapshot.Users) != 1 ||
		snapshot.Users[0].Status != StatusOnline || snapshot.Users[0].PresenceRevision != "42" {
		t.Fatalf("unexpected snapshot: %#v", snapshot)
	}
}
