package accountrealtime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
	userpresenceservice "github.com/tutti-os/tutti/services/tuttid/service/userpresence"
)

type fixedSessionSource struct {
	session *authbridge.Session
}

func (source fixedSessionSource) ReadSession() (*authbridge.Session, error) {
	return source.session, nil
}

func TestServiceMultiplexesConsumersOnOnePhysicalConnection(t *testing.T) {
	var connections atomic.Int32
	allowEvents := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connections.Add(1)
		conn, err := websocket.Accept(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		readRealtimeInitialization(t, conn)
		<-allowEvents
		writeBusinessEvent(t, conn, "device_link.attempt.changed", map[string]any{"attemptId": "attempt-1"}, Delivery{})
		writeBusinessEvent(t, conn, "connector.authorization.changed", map[string]any{"revision": 2}, Delivery{})
		<-request.Context().Done()
	}))
	defer server.Close()

	service := newTestService(t, server.URL)
	defer stopRealtime(t, service)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := make(chan Event, 1)
	second := make(chan Event, 1)
	go func() {
		_ = service.Listen(ctx, "", "device_link.attempt.changed", func(event Event) { first <- event })
	}()
	go func() {
		_ = service.Listen(ctx, "user-1", "connector.authorization.changed", func(event Event) { second <- event })
	}()
	waitForHandlerCount(t, service, 2)
	close(allowEvents)

	select {
	case <-first:
	case <-time.After(2 * time.Second):
		t.Fatal("mobile event was not dispatched")
	}
	select {
	case <-second:
	case <-time.After(2 * time.Second):
		t.Fatal("connector event was not dispatched")
	}
	if got := connections.Load(); got != 1 {
		t.Fatalf("logical consumers opened %d physical connections", got)
	}
}

func TestPresenceReplaceWaitsForACKAndFencesDelivery(t *testing.T) {
	delivered := make(chan Event, 2)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		conn, err := websocket.Accept(writer, request, nil)
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "done")
		readRealtimeInitialization(t, conn)
		writeEnvelope(t, conn, map[string]any{
			"protocol_version": 2, "type": "connection.ready",
			"payload": map[string]any{"connectionGeneration": "connection-1"},
		})
		_, raw, err := conn.Read(context.Background())
		if err != nil {
			t.Error(err)
			return
		}
		var replace struct {
			Action string `json:"action"`
			Data   struct {
				PresenceSessionEpoch string                                     `json:"presenceSessionEpoch"`
				Revision             uint64                                     `json:"revision"`
				Subscriptions        []userpresenceservice.PresenceSubscription `json:"subscriptions"`
			} `json:"data"`
		}
		if json.Unmarshal(raw, &replace) != nil || replace.Action != "presence.subscriptions.replace" || len(replace.Data.Subscriptions) != 1 {
			t.Errorf("unexpected replace frame: %s", raw)
			return
		}
		writeEnvelope(t, conn, map[string]any{
			"protocol_version": 2, "type": "presence.subscriptions.ack",
			"payload": map[string]any{
				"connectionGeneration": "connection-1", "presenceSessionEpoch": replace.Data.PresenceSessionEpoch,
				"revision": replace.Data.Revision, "desiredSetDigest": presenceDesiredSetDigest(map[string]string{
					replace.Data.Subscriptions[0].UserID: replace.Data.Subscriptions[0].SubscriptionID,
				}), "acceptedCount": 1,
			},
		})
		subscription := replace.Data.Subscriptions[0]
		baseDelivery := Delivery{
			Scope: "user_presence", SubjectUserID: subscription.UserID,
			ConnectionGeneration: "connection-1", PresenceSessionEpoch: replace.Data.PresenceSessionEpoch,
		}
		stale := baseDelivery
		stale.SubscriptionID = "stale-token"
		writeBusinessEvent(t, conn, "user.device-presence.changed", map[string]any{"userId": "user-1", "status": "ONLINE"}, stale)
		baseDelivery.SubscriptionID = subscription.SubscriptionID
		writeBusinessEvent(t, conn, "user.device-presence.changed", map[string]any{"userId": "user-1", "status": "ONLINE"}, baseDelivery)
		<-request.Context().Done()
	}))
	defer server.Close()

	service := newTestService(t, server.URL)
	defer stopRealtime(t, service)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = service.Listen(ctx, "", "user.device-presence.changed", func(event Event) { delivered <- event })
	}()
	waitForHandlerCount(t, service, 1)
	if err := service.ReplacePresenceSubscriptions(context.Background(), []userpresenceservice.PresenceSubscription{{
		UserID: "user-1", SubscriptionID: "subscription-1",
	}}); err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-delivered:
		if event.Delivery.SubscriptionID != "subscription-1" {
			t.Fatalf("stale delivery passed the fence: %#v", event.Delivery)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("valid presence event was not dispatched")
	}
	select {
	case event := <-delivered:
		t.Fatalf("unexpected second delivery: %#v", event)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestPresenceReplayACKNotifiesOnlyAfterConnectionGenerationChanges(t *testing.T) {
	service := &Service{
		presenceSessionEpoch: "epoch-1", desired: map[string]string{"user-1": "sub-1"},
		ackedDesired: map[string]string{}, ackSignal: make(chan struct{}), writeWake: make(chan struct{}, 1),
		presenceReplayACKHandlers: make(map[uint64]func()),
	}
	notified := 0
	service.OnPresenceReplayACK(func() { notified++ })
	service.generation = "connection-1"
	service.connectionOrdinal = 1
	desired := map[string]string{"user-1": "sub-1"}
	digest := presenceDesiredSetDigest(desired)
	service.inFlight = &presenceFrame{generation: "connection-1", revision: 1, digest: digest, subscriptions: desired}
	service.handlePresenceACK(json.RawMessage(`{
      "connectionGeneration":"connection-1","presenceSessionEpoch":"epoch-1",
      "revision":1,"desiredSetDigest":"sha256:wrong","acceptedCount":1
    }`))
	if service.inFlight == nil {
		t.Fatal("ACK for a different desired-set digest was accepted")
	}
	service.handlePresenceACK(json.RawMessage(`{
      "connectionGeneration":"connection-1","presenceSessionEpoch":"epoch-1",
      "revision":1,"desiredSetDigest":"` + digest + `","acceptedCount":1
    }`))
	if notified != 0 {
		t.Fatal("initial ACK was incorrectly classified as reconnect replay")
	}
	service.generation = "connection-2"
	service.connectionOrdinal = 2
	service.inFlight = &presenceFrame{generation: "connection-2", revision: 1, digest: digest, subscriptions: desired}
	service.handlePresenceACK(json.RawMessage(`{
      "connectionGeneration":"connection-2","presenceSessionEpoch":"epoch-1",
      "revision":1,"desiredSetDigest":"` + digest + `","acceptedCount":1
    }`))
	if notified != 1 {
		t.Fatalf("replay notifications = %d", notified)
	}
}

func TestResetPresenceSubscriptionsStartsEmptyEpochAndWakesWaiters(t *testing.T) {
	service := &Service{
		presenceSessionEpoch: "old-epoch", desired: map[string]string{"user-1": "sub-1"}, desiredRevision: 7,
		ackedDesired: map[string]string{"user-1": "sub-1"}, ackSignal: make(chan struct{}), writeWake: make(chan struct{}, 1),
	}
	oldSignal := service.ackSignal
	service.ResetPresenceSubscriptions()
	service.mu.RLock()
	defer service.mu.RUnlock()
	if service.presenceSessionEpoch == "old-epoch" || service.desiredRevision != 0 || !service.forcePresenceReplace || len(service.desired) != 0 || service.ackedRevision != 0 {
		t.Fatalf("unexpected reset state: epoch=%q revision=%d desired=%v acked=%d", service.presenceSessionEpoch, service.desiredRevision, service.desired, service.ackedRevision)
	}
	select {
	case <-oldSignal:
	default:
		t.Fatal("presence reset did not wake ACK waiters")
	}
}

func newTestService(t *testing.T, serverURL string) *Service {
	t.Helper()
	service, err := New(Config{
		URL: strings.Replace(serverURL, "http://", "ws://", 1), DeviceID: "device-1",
		Account: fixedSessionSource{session: &authbridge.Session{Cookie: "sid=test", UserID: "user-1"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func readRealtimeInitialization(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for index := 0; index < 2; index++ {
		if _, _, err := conn.Read(ctx); err != nil {
			t.Errorf("read realtime initialization: %v", err)
			return
		}
	}
}

func writeBusinessEvent(t *testing.T, conn *websocket.Conn, eventType string, payload any, delivery Delivery) {
	t.Helper()
	raw, _ := json.Marshal(payload)
	writeEnvelope(t, conn, map[string]any{
		"protocol_version": 2, "event_type": eventType, "dispatch_id": eventType + "-dispatch",
		"payload": base64.StdEncoding.EncodeToString(raw), "delivery": delivery,
	})
}

func writeEnvelope(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Error(err)
		return
	}
	if err := conn.Write(context.Background(), websocket.MessageText, raw); err != nil {
		t.Error(err)
	}
}

func waitForHandlerCount(t *testing.T, service *Service, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		service.mu.RLock()
		count := 0
		for _, handlers := range service.handlers {
			count += len(handlers)
		}
		service.mu.RUnlock()
		if count == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d handlers", want)
}

func stopRealtime(t *testing.T, service *Service) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	service.Stop(ctx)
}
