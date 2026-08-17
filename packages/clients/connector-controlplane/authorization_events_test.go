package connectorcontrolplane

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestConnectorAuthorizationEventParserAcceptsObjectAndGatewayEncoding(t *testing.T) {
	payload := `{"revision":19,"connectorId":"tencent-docs"}`
	object := []byte(`{"protocol_version":2,"event_type":"connector.authorization.changed","payload":` + payload + `}`)
	if !isConnectorAuthorizationChanged(object) {
		t.Fatal("object payload was not recognized")
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(payload))
	gateway := []byte(`{"protocol_version":2,"event_type":"connector.authorization.changed","payload":"` + encoded + `"}`)
	if !isConnectorAuthorizationChanged(gateway) {
		t.Fatal("gateway payload was not recognized")
	}
	if isConnectorAuthorizationChanged([]byte(`{"protocol_version":2,"event_type":"other","payload":{"revision":19}}`)) {
		t.Fatal("unrelated event was recognized")
	}
}

func TestAuthorizationEventSourceCarriesAccountAndPPEHeaders(t *testing.T) {
	notified := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Cookie") != "sid=account-1" || request.Header.Get("x-zk-ppe-lane") != "ppe-connectors" {
			t.Errorf("headers = %#v", request.Header)
		}
		conn, err := websocket.Accept(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		readCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		for range 2 {
			if _, _, err := conn.Read(readCtx); err != nil {
				t.Error(err)
				return
			}
		}
		payload, _ := json.Marshal(map[string]any{"revision": 2})
		envelope, _ := json.Marshal(map[string]any{
			"protocol_version": 2, "event_type": connectorAuthorizationChangedEvent,
			"payload": base64.StdEncoding.EncodeToString(payload),
		})
		_ = conn.Write(readCtx, websocket.MessageText, envelope)
		<-readCtx.Done()
	}))
	defer server.Close()
	source, err := NewAuthorizationEventSource(AuthorizationEventSourceConfig{
		URL: strings.Replace(server.URL, "http://", "ws://", 1), DeviceID: "device-1",
		HeadersForAccount: func(accountID string) (http.Header, error) {
			return http.Header{"Cookie": []string{"sid=" + accountID}, "x-zk-ppe-lane": []string{"ppe-connectors"}}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = source.RunAuthorizationEvents(ctx, "account-1", func() { notified <- struct{}{} }) }()
	select {
	case <-notified:
		cancel()
	case <-time.After(2 * time.Second):
		t.Fatal("authorization event was not delivered")
	}
}
