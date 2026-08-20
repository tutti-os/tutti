package connectorcontrolplane

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
)

func TestAuthorizationClientFetchesAccountSnapshot(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/desktop/v1/connector-authorizations/snapshot" {
			http.NotFound(response, request)
			return
		}
		_, _ = response.Write([]byte(`{"revision":"12","connectors":[{"connectorId":"tencent-docs","connectorVersion":"0.2.0","state":"reauth_required","connectionId":"connection-1","connectionVersion":"4"}]}`))
	}))
	defer server.Close()
	client, err := NewAuthorizationClient(AuthorizationClientConfig{
		BaseURL: server.URL, APIPrefix: "/api/desktop/v1", HTTPClient: server.Client(),
		AuthorizeAccountRequest: func(_ *http.Request, accountID string) error {
			if accountID != "account-1" {
				t.Fatalf("accountID = %q", accountID)
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := client.AuthorizationSnapshot(context.Background(), "account-1")
	if err != nil || snapshot.Revision != 12 || len(snapshot.Connectors) != 1 {
		t.Fatalf("snapshot = %#v, error = %v", snapshot, err)
	}
	projection := snapshot.Connectors[0]
	if projection.State != market.AuthorizationStateExpired || projection.ConnectionVersion != 4 || projection.ServerRevision != 12 || !projection.ServerSynchronized {
		t.Fatalf("projection = %#v", projection)
	}
}

func TestAuthorizationClientStartsAccountScopedSession(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Cookie") != "sid=user-session" {
			t.Fatalf("cookie = %q", request.Header.Get("Cookie"))
		}
		switch request.URL.Path {
		case "/api/desktop/v1/connectors/gmail/authorization-sessions":
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if _, exists := body["authorizationMethod"]; exists || body["clientRequestId"] != "request-1" || body["connectorVersion"] != "1.0.0" {
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
	client, err := NewAuthorizationClient(AuthorizationClientConfig{
		BaseURL: server.URL, APIPrefix: "/api/desktop/v1", HTTPClient: server.Client(),
		AuthorizeAccountRequest: func(request *http.Request, accountID string) error {
			if accountID != "account-1" {
				t.Fatalf("accountID = %q", accountID)
			}
			request.Header.Set("Cookie", "sid=user-session")
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Begin(context.Background(), market.AuthorizationStartRequest{
		OperationID: "operation-1", ClientRequestID: "request-1",
		Scope:     market.OperationScope{AccountID: "account-1"},
		Connector: market.Connector{Key: "gmail"},
		Release:   market.Release{Version: "1.0.0", Manifest: market.Manifest{AuthorizationKind: "oauth2"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.SessionID != "auth-1" || result.ActionType != "redirect" || result.AuthorizationURL != "https://auth.example/connect" || result.OperationID != "operation-1" {
		t.Fatalf("result = %#v", result)
	}
	observation, err := client.Observe(context.Background(), market.AuthorizationObserveRequest{Scope: market.OperationScope{AccountID: "account-1"}, Session: result})
	if err != nil {
		t.Fatal(err)
	}
	if observation.State != market.AuthorizationObservationConnected || observation.ConnectionID != "connection-oauth-1" {
		t.Fatalf("observation = %#v", observation)
	}
}

func TestAuthorizationClientAcceptsImmediateSuccessWithoutNextAction(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/connectors/tencent-docs/authorization-sessions" {
			http.NotFound(response, request)
			return
		}
		_, _ = response.Write([]byte(`{"session":{"sessionId":"auth-existing","connectorRevision":"0.2.0","status":"CONNECTOR_AUTHORIZATION_SESSION_STATUS_SUCCEEDED","resultConnectionId":"connection-existing"}}`))
	}))
	defer server.Close()
	client, err := NewAuthorizationClient(AuthorizationClientConfig{
		BaseURL: server.URL, APIPrefix: "/v1", HTTPClient: server.Client(),
		AuthorizeAccountRequest: func(*http.Request, string) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Begin(context.Background(), market.AuthorizationStartRequest{
		OperationID: "operation-existing", ClientRequestID: "request-existing",
		Scope: market.OperationScope{AccountID: "account-1"}, Connector: market.Connector{Key: "tencent-docs"},
		Release: market.Release{Version: "0.2.0", Manifest: market.Manifest{AuthorizationKind: "oauth2"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.State != market.AuthorizationStateConnected || result.ConnectionID != "connection-existing" ||
		result.ActionType != "" || result.AuthorizationURL != "" {
		t.Fatalf("immediate success = %#v", result)
	}
}

func TestAuthorizationClientReplacesAndCancelsRemoteSession(t *testing.T) {
	requests := make([]string, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests = append(requests, request.Method+" "+request.URL.Path)
		switch request.URL.Path {
		case "/v1/connectors/notion/authorization-sessions":
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["replacementPolicy"] != "CONNECTOR_AUTHORIZATION_REPLACEMENT_POLICY_REPLACE_ACTIVE" {
				t.Fatalf("replacementPolicy = %#v", body["replacementPolicy"])
			}
			_, _ = response.Write([]byte(`{"session":{"sessionId":"auth-replacement","connectorRevision":"1.0.0","status":"CONNECTOR_AUTHORIZATION_SESSION_STATUS_AWAITING_USER","nextAction":{"type":"redirect","url":"https://auth.example/connect"}}}`))
		case "/v1/connector-authorization-sessions/auth-replacement":
			if request.Method != http.MethodDelete {
				t.Fatalf("cancel method = %s", request.Method)
			}
			_, _ = response.Write([]byte(`{"session":{"sessionId":"auth-replacement","status":"CONNECTOR_AUTHORIZATION_SESSION_STATUS_CANCELED","errorCode":"authorization_canceled"}}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	client, err := NewAuthorizationClient(AuthorizationClientConfig{
		BaseURL: server.URL, APIPrefix: "/v1", HTTPClient: server.Client(),
		AuthorizeAccountRequest: func(*http.Request, string) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := client.Begin(context.Background(), market.AuthorizationStartRequest{
		OperationID: "operation-replacement", ClientRequestID: "request-replacement",
		ReplacementPolicy: market.AuthorizationReplacementPolicyReplaceActive,
		Scope:             market.OperationScope{AccountID: "account-1"}, Connector: market.Connector{Key: "notion"},
		Release: market.Release{Version: "1.0.0", Manifest: market.Manifest{AuthorizationKind: "oauth2"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Cancel(context.Background(), market.AuthorizationCancelRequest{
		OperationID: "operation-replacement", Scope: market.OperationScope{AccountID: "account-1"}, Session: session,
	}); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 2 || requests[0] != "POST /v1/connectors/notion/authorization-sessions" || requests[1] != "DELETE /v1/connector-authorization-sessions/auth-replacement" {
		t.Fatalf("requests = %#v", requests)
	}
}

func TestAuthorizationClientSubmitsNativeSecretWithoutPersistingItInSession(t *testing.T) {
	const token = "user-provided-token"
	notifications := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/connectors/mail/authorization-sessions":
			_, _ = response.Write([]byte(`{"session":{"sessionId":"auth-secret-1","connectorRevision":"2.0.0","nextAction":{"type":"submit_secret"}}}`))
		case "/v1/connector-authorization-sessions/auth-secret-1/complete":
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
	client, err := NewAuthorizationClient(AuthorizationClientConfig{
		BaseURL: server.URL, APIPrefix: "/v1", HTTPClient: server.Client(),
		AuthorizeAccountRequest:    func(*http.Request, string) error { return nil },
		NotifyAuthorizationChanged: func() { notifications++ },
	})
	if err != nil {
		t.Fatal(err)
	}
	secret := []byte(token)
	result, err := client.Begin(context.Background(), market.AuthorizationStartRequest{
		OperationID: "operation-secret-1", ClientRequestID: "request-secret-1", Secret: secret,
		Scope:     market.OperationScope{AccountID: "account-1"},
		Connector: market.Connector{Key: "mail"},
		Release:   market.Release{Version: "2.0.0", Manifest: market.Manifest{AuthorizationKind: "api_key"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.SessionID != "auth-secret-1" || result.ActionType != "submit_secret" || result.AuthorizationURL != "" || result.ConnectionID != "connection-secret-1" {
		t.Fatalf("result = %#v", result)
	}
	if notifications != 2 {
		t.Fatalf("authorization change notifications = %d, want 2", notifications)
	}
	for i, value := range secret {
		if value != 0 {
			t.Fatalf("secret[%d] was not cleared", i)
		}
	}
}

func TestAuthorizationClientDisconnectsByConnector(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodDelete || request.URL.Path != "/v1/connectors/tencent-docs/authorization" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		response.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client, err := NewAuthorizationClient(AuthorizationClientConfig{
		BaseURL: server.URL, APIPrefix: "/v1", HTTPClient: server.Client(),
		AuthorizeAccountRequest: func(*http.Request, string) error { return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Disconnect(context.Background(), market.AuthorizationDisconnectRequest{
		Scope: market.OperationScope{AccountID: "account-1"}, Connector: market.Connector{Key: "tencent-docs"},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestAuthorizationClientRejectsUnsafeEndpointConfiguration(t *testing.T) {
	tests := []AuthorizationClientConfig{
		{BaseURL: "https://user:secret@example.com", APIPrefix: "/v1"},
		{BaseURL: "https://example.com?target=other", APIPrefix: "/v1"},
		{BaseURL: "http://example.com", APIPrefix: "/v1"},
		{BaseURL: "https://example.com", APIPrefix: ""},
		{BaseURL: "https://example.com", APIPrefix: "/v1?target=other"},
	}
	for _, config := range tests {
		config.HTTPClient = http.DefaultClient
		config.AuthorizeAccountRequest = func(*http.Request, string) error { return nil }
		if _, err := NewAuthorizationClient(config); err == nil {
			t.Fatalf("expected configuration to be rejected: %#v", config)
		}
	}
}
