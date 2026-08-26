package accountrealtime

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	authbridge "github.com/tutti-os/tutti/packages/auth/bridge-go"
	userpresenceservice "github.com/tutti-os/tutti/services/tuttid/service/userpresence"
)

const (
	DefaultRealtimeURL     = "wss://ws.tutti.sh/"
	protocolVersion        = 2
	heartbeatInterval      = 3 * time.Minute
	controlRetryInterval   = 5 * time.Second
	maximumControlAttempts = 3
	maximumControlBytes    = 30 * 1024
)

type SessionSource interface {
	ReadSession() (*authbridge.Session, error)
}

type Config struct {
	URL      string
	DeviceID string
	Headers  http.Header
	Account  SessionSource
}

type Delivery struct {
	Scope                string `json:"scope"`
	TenantID             string `json:"tenant_id"`
	UserID               string `json:"user_id"`
	DeviceID             string `json:"device_id"`
	SubjectUserID        string `json:"subject_user_id"`
	ConnectionGeneration string `json:"connection_generation"`
	PresenceSessionEpoch string `json:"presence_session_epoch"`
	SubscriptionID       string `json:"subscription_id"`
}

type Event struct {
	Type       string
	Payload    []byte
	Delivery   Delivery
	DispatchID string
}

type Handler func(Event)

type registeredHandler struct {
	expectedAccountID string
	handler           Handler
}

type Service struct {
	url                  string
	deviceID             string
	headers              http.Header
	account              SessionSource
	presenceSessionEpoch string

	mu                        sync.RWMutex
	currentAccount            string
	generation                string
	connectionOrdinal         uint64
	handlers                  map[string]map[uint64]registeredHandler
	presenceReplayACKHandlers map[uint64]func()
	nextHandlerID             uint64
	desired                   map[string]string
	desiredRevision           uint64
	forcePresenceReplace      bool
	ackedRevision             uint64
	ackedGeneration           string
	ackedDesired              map[string]string
	inFlight                  *presenceFrame
	ackSignal                 chan struct{}
	writeWake                 chan struct{}
	sessionWake               chan struct{}
	cancel                    context.CancelFunc
	done                      chan struct{}
	replaceMu                 sync.Mutex
}

type presenceFrame struct {
	generation    string
	revision      uint64
	digest        string
	subscriptions map[string]string
	raw           []byte
	attempts      int
	lastSentAt    time.Time
}

func New(config Config) (*Service, error) {
	deviceID := strings.TrimSpace(config.DeviceID)
	if deviceID == "" || config.Account == nil {
		return nil, errors.New("account realtime device and session source are required")
	}
	endpoint, err := realtimeEndpoint(config.URL, deviceID)
	if err != nil {
		return nil, err
	}
	return &Service{
		url: endpoint, deviceID: deviceID, headers: config.Headers.Clone(), account: config.Account,
		presenceSessionEpoch: uuid.NewString(), handlers: make(map[string]map[uint64]registeredHandler),
		presenceReplayACKHandlers: make(map[uint64]func()),
		desired:                   make(map[string]string), ackedDesired: make(map[string]string),
		ackSignal: make(chan struct{}), writeWake: make(chan struct{}, 1), sessionWake: make(chan struct{}, 1),
	}, nil
}

// OnPresenceReplayACK observes Presence ACKs on replacement physical
// connections, not ACKs on the first connection. This avoids duplicate first
// snapshots while still closing every reconnect event gap with an immediate
// current-room read, including a set that had not been ACKed before disconnect.
func (s *Service) OnPresenceReplayACK(handler func()) func() {
	if s == nil || handler == nil {
		return func() {}
	}
	s.mu.Lock()
	s.nextHandlerID++
	handlerID := s.nextHandlerID
	s.presenceReplayACKHandlers[handlerID] = handler
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		delete(s.presenceReplayACKHandlers, handlerID)
		s.mu.Unlock()
	}
}

func (s *Service) PresenceSessionEpoch() string {
	if s == nil {
		return ""
	}
	return s.presenceSessionEpoch
}

func (s *Service) CurrentUserID() string {
	if s == nil {
		return ""
	}
	s.mu.RLock()
	current := s.currentAccount
	s.mu.RUnlock()
	if current != "" {
		return current
	}
	session, err := s.account.ReadSession()
	if err != nil || session == nil {
		return ""
	}
	return strings.TrimSpace(session.UserID)
}

func (s *Service) Start() {
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.cancel != nil {
		s.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.cancel = cancel
	s.done = done
	s.mu.Unlock()
	go s.run(ctx, done)
}

func (s *Service) Stop(ctx context.Context) {
	if s == nil {
		return
	}
	s.mu.RLock()
	cancel, done := s.cancel, s.done
	s.mu.RUnlock()
	if cancel == nil || done == nil {
		return
	}
	cancel()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func (s *Service) NotifySessionChanged() {
	if s == nil {
		return
	}
	select {
	case s.sessionWake <- struct{}{}:
	default:
	}
}

// Listen registers a logical consumer on the single physical account/device
// socket. It blocks until ctx ends; reconnects are owned centrally and do not
// cause each consumer to open a competing canonical connection.
func (s *Service) Listen(ctx context.Context, expectedAccountID, eventType string, handler Handler) error {
	if s == nil || handler == nil || strings.TrimSpace(eventType) == "" {
		return errors.New("account realtime listener is invalid")
	}
	eventType = strings.TrimSpace(eventType)
	s.mu.Lock()
	s.nextHandlerID++
	handlerID := s.nextHandlerID
	if s.handlers[eventType] == nil {
		s.handlers[eventType] = make(map[uint64]registeredHandler)
	}
	s.handlers[eventType][handlerID] = registeredHandler{
		expectedAccountID: strings.TrimSpace(expectedAccountID), handler: handler,
	}
	s.mu.Unlock()
	s.Start()
	defer func() {
		s.mu.Lock()
		delete(s.handlers[eventType], handlerID)
		if len(s.handlers[eventType]) == 0 {
			delete(s.handlers, eventType)
		}
		s.mu.Unlock()
	}()
	<-ctx.Done()
	return nil
}

func (s *Service) ReplacePresenceSubscriptions(ctx context.Context, subscriptions []userpresenceservice.PresenceSubscription) error {
	if s == nil {
		return errors.New("account realtime is unavailable")
	}
	desired, err := validateDesiredPresence(subscriptions)
	if err != nil {
		return err
	}
	s.Start()
	s.replaceMu.Lock()
	defer s.replaceMu.Unlock()

	s.mu.Lock()
	if !sameMemberships(s.desired, desired) {
		if s.desiredRevision >= 9_007_199_254_740_991 {
			s.mu.Unlock()
			return errors.New("presence revision exhausted for the process epoch")
		}
		s.desired = desired
		s.desiredRevision++
	} else if s.forcePresenceReplace && s.desiredRevision == 0 {
		s.desiredRevision = 1
	}
	targetRevision := s.desiredRevision
	targetEpoch := s.presenceSessionEpoch
	s.mu.Unlock()
	if targetRevision == 0 {
		return nil
	}
	s.wakeWriter()
	for {
		s.mu.RLock()
		if s.presenceSessionEpoch != targetEpoch {
			s.mu.RUnlock()
			return errors.New("presence subscriptions were reset while waiting for ACK")
		}
		acked := s.generation != "" && s.ackedGeneration == s.generation && s.ackedRevision == targetRevision && sameMemberships(s.ackedDesired, desired)
		ackSignal := s.ackSignal
		done := s.done
		s.mu.RUnlock()
		if acked {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ackSignal:
		case <-done:
			return errors.New("account realtime stopped before presence ACK")
		}
	}
}

// ResetPresenceSubscriptions fences deliveries from the prior account
// lifecycle. The first desired set in the new epoch is assigned revision one;
// until then old server-side interests cannot pass the new epoch fence.
func (s *Service) ResetPresenceSubscriptions() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.presenceSessionEpoch = uuid.NewString()
	s.desired = make(map[string]string)
	s.desiredRevision = 0
	s.forcePresenceReplace = true
	s.ackedRevision = 0
	s.ackedGeneration = ""
	s.ackedDesired = make(map[string]string)
	s.inFlight = nil
	s.signalACKLocked()
	s.mu.Unlock()
	s.wakeWriter()
}

func (s *Service) run(ctx context.Context, done chan struct{}) {
	defer func() {
		s.mu.Lock()
		if s.done == done {
			s.cancel = nil
			s.done = nil
		}
		s.signalACKLocked()
		s.mu.Unlock()
		close(done)
	}()
	retry := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		session, err := s.account.ReadSession()
		if err != nil || session == nil || strings.TrimSpace(session.Cookie) == "" || strings.TrimSpace(session.UserID) == "" {
			if !s.waitForSession(ctx, time.Second) {
				return
			}
			continue
		}
		accountID := strings.TrimSpace(session.UserID)
		s.mu.Lock()
		if s.currentAccount != "" && s.currentAccount != accountID {
			s.resetPresenceLocked()
		}
		s.currentAccount = accountID
		s.mu.Unlock()
		err = s.runConnection(ctx, accountID, strings.TrimSpace(session.Cookie))
		if ctx.Err() != nil {
			return
		}
		if errors.Is(err, errSessionChanged) {
			retry = time.Second
			continue
		}
		if !s.waitForSession(ctx, retry) {
			return
		}
		if retry < 15*time.Second {
			retry *= 2
		}
	}
}

var errSessionChanged = errors.New("account realtime session changed")

func (s *Service) runConnection(ctx context.Context, accountID, cookie string) error {
	connectionCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	headers := s.headers.Clone()
	if headers == nil {
		headers = make(http.Header)
	}
	headers.Set("Cookie", cookie)
	conn, _, err := websocket.Dial(connectionCtx, s.url, &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		return err
	}
	defer conn.Close(websocket.StatusNormalClosure, "account realtime connection stopped")
	conn.SetReadLimit(64 * 1024)
	if err := writeAction(connectionCtx, conn, "connection.initialize", map[string]any{"protocolVersion": protocolVersion}); err != nil {
		return err
	}
	if err := writeAction(connectionCtx, conn, "init", map[string]any{"deviceId": s.deviceID}); err != nil {
		return err
	}

	readResult := make(chan error, 1)
	go func() { readResult <- s.readLoop(connectionCtx, conn, accountID) }()
	writeResult := make(chan error, 1)
	go func() { writeResult <- s.writeLoop(connectionCtx, conn) }()
	select {
	case <-ctx.Done():
		return nil
	case <-s.sessionWake:
		return errSessionChanged
	case err := <-readResult:
		return err
	case err := <-writeResult:
		return err
	}
}

func (s *Service) readLoop(ctx context.Context, conn *websocket.Conn, accountID string) error {
	defer s.clearConnection()
	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		s.handleEnvelope(raw, accountID)
	}
}

func (s *Service) writeLoop(ctx context.Context, conn *websocket.Conn) error {
	heartbeat := time.NewTicker(heartbeatInterval)
	retry := time.NewTicker(time.Second)
	defer heartbeat.Stop()
	defer retry.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case now := <-heartbeat.C:
			if err := writeAction(ctx, conn, "ping", map[string]any{"ts": now.UnixMilli()}); err != nil {
				return err
			}
		case <-s.writeWake:
			if err := s.writePendingPresence(ctx, conn, false); err != nil {
				return err
			}
		case now := <-retry.C:
			if err := s.retryPendingPresence(ctx, conn, now); err != nil {
				return err
			}
		}
	}
}

func (s *Service) handleEnvelope(raw []byte, accountID string) {
	var envelope struct {
		ProtocolVersion int             `json:"protocol_version"`
		Type            string          `json:"type"`
		EventType       string          `json:"event_type"`
		DispatchID      string          `json:"dispatch_id"`
		Payload         json.RawMessage `json:"payload"`
		Delivery        Delivery        `json:"delivery"`
	}
	if json.Unmarshal(raw, &envelope) != nil || envelope.ProtocolVersion != protocolVersion {
		return
	}
	if envelope.Type == "connection.ready" {
		var payload struct {
			ConnectionGeneration string `json:"connectionGeneration"`
		}
		if json.Unmarshal(envelope.Payload, &payload) != nil || strings.TrimSpace(payload.ConnectionGeneration) == "" {
			return
		}
		s.mu.Lock()
		generation := strings.TrimSpace(payload.ConnectionGeneration)
		if s.generation != generation {
			s.connectionOrdinal++
		}
		s.generation = generation
		s.inFlight = nil
		s.signalACKLocked()
		s.mu.Unlock()
		s.wakeWriter()
		return
	}
	if envelope.Type == "presence.subscriptions.ack" {
		s.handlePresenceACK(envelope.Payload)
		return
	}
	eventType := strings.TrimSpace(envelope.EventType)
	if eventType == "" {
		eventType = strings.TrimSpace(envelope.Type)
	}
	if eventType == "" {
		return
	}
	payload, ok := decodeBusinessPayload(envelope.Payload)
	if !ok {
		return
	}
	if envelope.Delivery.Scope == "user_presence" && !s.validPresenceDelivery(payload, envelope.Delivery) {
		return
	}
	s.dispatch(accountID, Event{Type: eventType, Payload: payload, Delivery: envelope.Delivery, DispatchID: envelope.DispatchID})
}

func (s *Service) handlePresenceACK(raw json.RawMessage) {
	var ack struct {
		ConnectionGeneration string `json:"connectionGeneration"`
		PresenceSessionEpoch string `json:"presenceSessionEpoch"`
		Revision             uint64 `json:"revision"`
		DesiredSetDigest     string `json:"desiredSetDigest"`
		AcceptedCount        int    `json:"acceptedCount"`
	}
	if json.Unmarshal(raw, &ack) != nil {
		return
	}
	s.mu.Lock()
	if s.inFlight == nil || ack.ConnectionGeneration != s.generation || ack.ConnectionGeneration != s.inFlight.generation ||
		ack.PresenceSessionEpoch != s.presenceSessionEpoch || ack.Revision != s.inFlight.revision || ack.AcceptedCount != len(s.inFlight.subscriptions) {
		s.mu.Unlock()
		return
	}
	if ack.DesiredSetDigest != s.inFlight.digest {
		s.mu.Unlock()
		return
	}
	replayed := s.connectionOrdinal > 1
	s.ackedRevision = ack.Revision
	s.ackedGeneration = ack.ConnectionGeneration
	s.ackedDesired = cloneMemberships(s.inFlight.subscriptions)
	s.inFlight = nil
	s.signalACKLocked()
	handlers := make([]func(), 0, len(s.presenceReplayACKHandlers))
	if replayed {
		for _, handler := range s.presenceReplayACKHandlers {
			handlers = append(handlers, handler)
		}
	}
	s.mu.Unlock()
	s.wakeWriter()
	for _, handler := range handlers {
		handler()
	}
}

func (s *Service) validPresenceDelivery(payload []byte, delivery Delivery) bool {
	var body struct {
		UserID string `json:"userId"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return delivery.ConnectionGeneration == s.generation &&
		delivery.PresenceSessionEpoch == s.presenceSessionEpoch &&
		strings.TrimSpace(delivery.SubjectUserID) == strings.TrimSpace(body.UserID) &&
		s.ackedDesired[delivery.SubjectUserID] == delivery.SubscriptionID
}

func (s *Service) dispatch(accountID string, event Event) {
	s.mu.RLock()
	registered := s.handlers[event.Type]
	handlers := make([]Handler, 0, len(registered))
	for _, candidate := range registered {
		if candidate.expectedAccountID == "" || candidate.expectedAccountID == accountID {
			handlers = append(handlers, candidate.handler)
		}
	}
	s.mu.RUnlock()
	for _, handler := range handlers {
		handler(event)
	}
}

func (s *Service) writePendingPresence(ctx context.Context, conn *websocket.Conn, retry bool) error {
	s.mu.Lock()
	if s.generation == "" {
		s.mu.Unlock()
		return nil
	}
	if s.desiredRevision == 0 {
		if !s.forcePresenceReplace {
			s.mu.Unlock()
			return nil
		}
		s.desiredRevision = 1
	}
	if s.inFlight != nil {
		frame := s.inFlight
		if !retry {
			s.mu.Unlock()
			return nil
		}
		frame.attempts++
		frame.lastSentAt = time.Now()
		raw := append([]byte(nil), frame.raw...)
		s.mu.Unlock()
		return conn.Write(ctx, websocket.MessageText, raw)
	}
	if s.ackedGeneration == s.generation && s.ackedRevision == s.desiredRevision && sameMemberships(s.ackedDesired, s.desired) {
		s.mu.Unlock()
		return nil
	}
	subscriptions := sortedPresenceSubscriptions(s.desired)
	raw, err := json.Marshal(struct {
		Action string `json:"action"`
		Data   struct {
			ConnectionGeneration string                                     `json:"connectionGeneration"`
			PresenceSessionEpoch string                                     `json:"presenceSessionEpoch"`
			Revision             uint64                                     `json:"revision"`
			Subscriptions        []userpresenceservice.PresenceSubscription `json:"subscriptions"`
		} `json:"data"`
	}{
		Action: "presence.subscriptions.replace",
		Data: struct {
			ConnectionGeneration string                                     `json:"connectionGeneration"`
			PresenceSessionEpoch string                                     `json:"presenceSessionEpoch"`
			Revision             uint64                                     `json:"revision"`
			Subscriptions        []userpresenceservice.PresenceSubscription `json:"subscriptions"`
		}{s.generation, s.presenceSessionEpoch, s.desiredRevision, subscriptions},
	})
	if err != nil {
		s.mu.Unlock()
		return err
	}
	if len(raw) > maximumControlBytes {
		s.mu.Unlock()
		return errors.New("presence subscriptions exceed the 30 KiB control-frame budget")
	}
	s.inFlight = &presenceFrame{
		generation: s.generation, revision: s.desiredRevision, subscriptions: cloneMemberships(s.desired),
		digest: presenceDesiredSetDigest(s.desired), raw: raw, attempts: 1, lastSentAt: time.Now(),
	}
	s.forcePresenceReplace = false
	s.mu.Unlock()
	return conn.Write(ctx, websocket.MessageText, raw)
}

func (s *Service) retryPendingPresence(ctx context.Context, conn *websocket.Conn, now time.Time) error {
	s.mu.RLock()
	frame := s.inFlight
	if frame == nil || now.Sub(frame.lastSentAt) < controlRetryInterval {
		s.mu.RUnlock()
		return nil
	}
	attempts := frame.attempts
	s.mu.RUnlock()
	if attempts >= maximumControlAttempts {
		return errors.New("presence subscription ACK timeout")
	}
	return s.writePendingPresence(ctx, conn, true)
}

func (s *Service) clearConnection() {
	s.mu.Lock()
	s.generation = ""
	s.inFlight = nil
	s.signalACKLocked()
	s.mu.Unlock()
}

func (s *Service) resetPresenceLocked() {
	s.desired = make(map[string]string)
	s.desiredRevision = 0
	s.forcePresenceReplace = false
	s.ackedRevision = 0
	s.ackedGeneration = ""
	s.ackedDesired = make(map[string]string)
	s.inFlight = nil
	s.presenceSessionEpoch = uuid.NewString()
	s.signalACKLocked()
}

func (s *Service) signalACKLocked() {
	close(s.ackSignal)
	s.ackSignal = make(chan struct{})
}

func (s *Service) wakeWriter() {
	select {
	case s.writeWake <- struct{}{}:
	default:
	}
}

func (s *Service) waitForSession(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-s.sessionWake:
		return true
	case <-timer.C:
		return true
	}
}

func validateDesiredPresence(subscriptions []userpresenceservice.PresenceSubscription) (map[string]string, error) {
	if len(subscriptions) > userpresenceservice.DefaultMaximumPresenceUsers {
		return nil, errors.New("presence subscriptions exceed the hard limit of 100")
	}
	desired := make(map[string]string, len(subscriptions))
	for _, subscription := range subscriptions {
		userID := strings.TrimSpace(subscription.UserID)
		subscriptionID := strings.TrimSpace(subscription.SubscriptionID)
		if userID == "" || len([]byte(userID)) > 256 || subscriptionID == "" || len([]byte(subscriptionID)) > 128 {
			return nil, errors.New("presence subscription identity is invalid")
		}
		if _, exists := desired[userID]; exists {
			return nil, errors.New("presence subscriptions contain duplicate users")
		}
		desired[userID] = subscriptionID
	}
	return desired, nil
}

func sortedPresenceSubscriptions(desired map[string]string) []userpresenceservice.PresenceSubscription {
	result := make([]userpresenceservice.PresenceSubscription, 0, len(desired))
	for userID, subscriptionID := range desired {
		result = append(result, userpresenceservice.PresenceSubscription{UserID: userID, SubscriptionID: subscriptionID})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].UserID < result[j].UserID })
	return result
}

func cloneMemberships(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func sameMemberships(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}

func presenceDesiredSetDigest(memberships map[string]string) string {
	users := make([]string, 0, len(memberships))
	for userID := range memberships {
		users = append(users, userID)
	}
	sort.Strings(users)
	hash := sha256.New()
	for _, userID := range users {
		_, _ = hash.Write([]byte(userID))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(memberships[userID]))
		_, _ = hash.Write([]byte{0})
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil))
}

func decodeBusinessPayload(raw json.RawMessage) ([]byte, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	if raw[0] != '"' {
		if !json.Valid(raw) {
			return nil, false
		}
		return append([]byte(nil), raw...), true
	}
	var encoded string
	if json.Unmarshal(raw, &encoded) != nil {
		return nil, false
	}
	payload, err := base64.StdEncoding.DecodeString(encoded)
	return payload, err == nil && json.Valid(payload)
}

func writeAction(ctx context.Context, conn *websocket.Conn, action string, data map[string]any) error {
	raw, err := json.Marshal(struct {
		Action string         `json:"action"`
		Data   map[string]any `json:"data"`
	}{Action: action, Data: data})
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, raw)
}

func realtimeEndpoint(rawURL, deviceID string) (string, error) {
	if rawURL = strings.TrimSpace(rawURL); rawURL == "" {
		rawURL = DefaultRealtimeURL
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Host == "" || parsed.Scheme != "ws" && parsed.Scheme != "wss" {
		return "", fmt.Errorf("account realtime URL is invalid")
	}
	query := parsed.Query()
	query.Set("deviceId", strings.TrimSpace(deviceID))
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}
