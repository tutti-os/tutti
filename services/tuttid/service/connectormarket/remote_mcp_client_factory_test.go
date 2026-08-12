package connectormarket

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/host"
	implementationhost "github.com/tutti-os/tutti/packages/connector/runtime/implementationhost"
	"github.com/tutti-os/tutti/packages/connector/runtime/mcp"
)

func TestDirectRemoteMCPClientFactoryBuildsFixedGatewayRouteAndAuthorizesAccount(t *testing.T) {
	var gotAccountID string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/desktop/v1/connectors/documents/mcp" || request.Header.Get("Cookie") != "session_id=session-1" {
			t.Errorf("request path/cookie = %q / %q", request.URL.Path, request.Header.Get("Cookie"))
		}
		var message struct {
			ID json.RawMessage `json:"id"`
		}
		if err := json.NewDecoder(request.Body).Decode(&message); err != nil {
			t.Error(err)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{
			"jsonrpc": "2.0", "id": message.ID, "result": map[string]any{"resultType": "complete"},
		})
	}))
	defer server.Close()

	factory, err := NewDirectRemoteMCPClientFactory(DirectRemoteMCPClientFactoryConfig{
		BaseURL: server.URL + "/api/desktop", HTTPClient: server.Client(),
		AuthorizeAccountRequest: func(request *http.Request, accountID string) error {
			gotAccountID = accountID
			request.Header.Set("Cookie", "session_id=session-1")
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	client, err := factory.NewRemoteMCPClient(context.Background(), implementationhost.RemoteMCPClientRequest{
		ConnectorKey: "documents", AccountID: "account-1", Version: "1.2.3",
		Implementation: market.RemoteStreamableHTTPImplementation{ProtocolVersion: mcp.ModernProtocolVersion},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Call(context.Background(), "server/discover", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if gotAccountID != "account-1" {
		t.Fatalf("authorized account = %q", gotAccountID)
	}
}
