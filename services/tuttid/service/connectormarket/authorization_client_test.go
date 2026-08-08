package connectormarket

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/host"
)

func TestConnectorAuthorizationClientStartsAccountScopedSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Cookie") != "sid=user-session" {
			t.Fatalf("cookie = %q", request.Header.Get("Cookie"))
		}
		switch request.URL.Path {
		case "/api/desktop/v1/connectors/gmail/authorization-options":
			if request.URL.Query().Get("connectorVersion") != "1.0.0" {
				t.Fatalf("connectorVersion = %q", request.URL.Query().Get("connectorVersion"))
			}
			_, _ = response.Write([]byte(`{"options":[{"authorizationMethod":"oauth2"}]}`))
		case "/api/desktop/v1/connectors/gmail/authorization-sessions":
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["authorizationMethod"] != "oauth2" || body["clientRequestId"] != "request-1" || body["connectorVersion"] != "1.0.0" {
				t.Fatalf("body = %#v", body)
			}
			_, _ = response.Write([]byte(`{"session":{"sessionId":"auth-1","connectorRevision":"1.0.0","nextAction":{"type":"redirect","url":"https://auth.example/connect"}}}`))
		case "/api/desktop/v1/connector-authorization-sessions/auth-1":
			_, _ = response.Write([]byte(`{"session":{"status":"CONNECTOR_AUTHORIZATION_SESSION_STATUS_SUCCEEDED","resultConnectionId":"connection-oauth-1"}}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	client, err := NewConnectorAuthorizationClient(ConnectorAuthorizationClientConfig{
		BaseURL: server.URL + "/api/desktop", HTTPClient: server.Client(),
		AuthorizeRequest: func(request *http.Request) error { request.Header.Set("Cookie", "sid=user-session"); return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Begin(context.Background(), market.AuthorizationStartRequest{
		OperationID: "operation-1", ClientRequestID: "request-1",
		Connector: market.Connector{Key: "gmail"},
		Release:   market.Release{Version: "1.0.0", Manifest: market.Manifest{AuthorizationKind: "oauth2"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.SessionID != "auth-1" || result.ActionType != "redirect" || result.AuthorizationURL != "https://auth.example/connect" || result.OperationID != "operation-1" {
		t.Fatalf("result = %#v", result)
	}
	observation, err := client.Observe(context.Background(), market.AuthorizationObserveRequest{Session: result})
	if err != nil {
		t.Fatal(err)
	}
	if observation.State != market.AuthorizationObservationConnected || observation.ConnectionID != "connection-oauth-1" {
		t.Fatalf("observation = %#v", observation)
	}
}

func TestConnectorAuthorizationClientSubmitsNativeSecretWithoutPersistingItInSession(t *testing.T) {
	const token = "user-provided-token"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/connectors/mail/authorization-options":
			_, _ = response.Write([]byte(`{"options":[{"authorizationMethod":"api_key"}]}`))
		case "/v1/connectors/mail/authorization-sessions":
			_, _ = response.Write([]byte(`{"session":{"sessionId":"auth-secret-1","connectorRevision":"2.0.0","nextAction":{"type":"submit_secret"}}}`))
		case "/v1/connector-authorization-sessions/auth-secret-1:complete":
			var body struct {
				Secret struct {
					Secret string `json:"secret"`
				} `json:"secret"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil || body.Secret.Secret != token {
				t.Fatalf("complete body = %#v, %v", body, err)
			}
			_, _ = response.Write([]byte(`{"session":{"sessionId":"auth-secret-1","connectorRevision":"2.0.0","status":"CONNECTOR_AUTHORIZATION_SESSION_STATUS_SUCCEEDED","resultConnectionId":"connection-secret-1"}}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	client, err := NewConnectorAuthorizationClient(ConnectorAuthorizationClientConfig{
		BaseURL: server.URL, HTTPClient: server.Client(), AuthorizeRequest: func(*http.Request) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte(token)
	result, err := client.Begin(context.Background(), market.AuthorizationStartRequest{
		OperationID: "operation-secret-1", ClientRequestID: "request-secret-1", Secret: secret,
		Connector: market.Connector{Key: "mail"},
		Release:   market.Release{Version: "2.0.0", Manifest: market.Manifest{AuthorizationKind: "api_key"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.SessionID != "auth-secret-1" || result.ActionType != "submit_secret" || result.AuthorizationURL != "" || result.ConnectionID != "connection-secret-1" {
		t.Fatalf("result = %#v", result)
	}
	for i, value := range secret {
		if value != 0 {
			t.Fatalf("secret[%d] was not cleared", i)
		}
	}
}
