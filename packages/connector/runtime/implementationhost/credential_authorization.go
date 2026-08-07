package implementationhost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"sync"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/host"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

const credentialBrokerInitialEventTimeout = 30 * time.Second

type managedCLILaunch struct {
	arguments     []string
	artifactTrees []agentruntime.ArtifactTreeIdentity
	cwd           string
	executable    connectorruntime.ConnectorExecutable
	language      string
	stateDir      string
}

type credentialBrokerCLILaunch struct {
	Executable string   `json:"executable"`
	Arguments  []string `json:"arguments"`
	CWD        string   `json:"cwd"`
}

type managedCredentialBrokerLaunch struct {
	entrypoint    string
	timeout       time.Duration
	allowedHosts  map[string]struct{}
	cliLaunch     credentialBrokerCLILaunch
	executable    connectorruntime.ConnectorExecutable
	language      string
	cwd           string
	artifactTrees []agentruntime.ArtifactTreeIdentity
	stateDir      string
}

type managedCredentialAuthorizationHost interface {
	authorizationRoute(market.Connector) (*connectorRoute, error)
	startCredentialBroker(context.Context, *connectorRoute, credentialBrokerRequest) (agentruntime.ProcessConnection, uint64, error)
}

// managedCredentialAuthorizationProvider owns the host-side lifecycle of a
// connector-provided credential broker. Provider-specific commands, response
// parsing, and secret handoffs stay inside the verified connector adapter.
type managedCredentialAuthorizationProvider struct {
	host     managedCredentialAuthorizationHost
	mu       sync.Mutex
	sessions map[string]*credentialBrokerSession
}

type credentialBrokerRequest struct {
	Protocol  string `json:"protocol"`
	Operation string `json:"operation"`
}

type credentialBrokerEvent struct {
	Type    string `json:"type"`
	URL     string `json:"url,omitempty"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

type credentialBrokerSession struct {
	cancel context.CancelFunc

	mu      sync.Mutex
	state   market.AuthorizationState
	url     string
	err     error
	version uint64
	changed chan struct{}
}

func newManagedCredentialAuthorizationProvider(host managedCredentialAuthorizationHost) *managedCredentialAuthorizationProvider {
	return &managedCredentialAuthorizationProvider{host: host, sessions: make(map[string]*credentialBrokerSession)}
}

func (host *Host) BeginAuthorization(ctx context.Context, request market.AuthorizationStartRequest) (market.AuthorizationSession, error) {
	if host == nil || host.authorizationProvider == nil {
		return market.AuthorizationSession{}, errors.New("connector authorization provider is unavailable")
	}
	return host.authorizationProvider.Begin(ctx, request)
}

func (host *Host) DisconnectAuthorization(ctx context.Context, request market.AuthorizationDisconnectRequest) error {
	if host == nil || host.authorizationProvider == nil {
		return errors.New("connector authorization provider is unavailable")
	}
	return host.authorizationProvider.Disconnect(ctx, request)
}

func (provider *managedCredentialAuthorizationProvider) Begin(
	ctx context.Context,
	request market.AuthorizationStartRequest,
) (market.AuthorizationSession, error) {
	route, err := provider.host.authorizationRoute(request.Connector)
	if err != nil {
		return market.AuthorizationSession{}, err
	}
	session, err := provider.authorizationSessionOrStart(route)
	if err != nil {
		return market.AuthorizationSession{}, err
	}
	if err := session.awaitInitialEvent(ctx); err != nil {
		provider.clearAuthorizationSession(route.id, session)
		session.cancel()
		return market.AuthorizationSession{}, err
	}
	state, authorizationURL, sessionErr := session.snapshot()
	if sessionErr != nil {
		provider.clearAuthorizationSession(route.id, session)
		return market.AuthorizationSession{}, sessionErr
	}
	result := market.AuthorizationSession{
		OperationID:      request.OperationID,
		ConnectorKey:     request.Connector.Key,
		SessionID:        request.OperationID + "/credential-broker",
		AuthorizationURL: authorizationURL,
		State:            state,
	}
	if state == market.AuthorizationStateConnected {
		provider.clearAuthorizationSession(route.id, session)
	}
	return result, nil
}

func (provider *managedCredentialAuthorizationProvider) Disconnect(
	ctx context.Context,
	request market.AuthorizationDisconnectRequest,
) error {
	route, err := provider.host.authorizationRoute(request.Connector)
	if err != nil {
		return err
	}
	if session := provider.takeAuthorizationSession(route.id); session != nil {
		session.cancel()
	}
	operationContext, cancel := context.WithTimeout(ctx, route.credentialBrokerLaunch.timeout)
	defer cancel()
	connection, processID, err := provider.host.startCredentialBroker(operationContext, route, credentialBrokerRequest{
		Protocol: market.CredentialBrokerProtocolV1, Operation: "disconnect",
	})
	if err != nil {
		return fmt.Errorf("start connector credential broker disconnect: %w", err)
	}
	defer route.releaseProcess(processID, connection)
	event, err := readCredentialBrokerTerminalEvent(operationContext, connection)
	if err != nil {
		return fmt.Errorf("disconnect connector authorization: %w", err)
	}
	if event.Type != "disconnected" {
		return credentialBrokerEventError(event, "disconnect")
	}
	return nil
}

func (provider *managedCredentialAuthorizationProvider) authorizationSessionOrStart(route *connectorRoute) (*credentialBrokerSession, error) {
	provider.mu.Lock()
	if session := provider.sessions[route.id]; session != nil {
		_, _, sessionErr := session.snapshot()
		if sessionErr == nil {
			provider.mu.Unlock()
			return session, nil
		}
		// A broker can fail after emitting its first authorization URL. Do not
		// make the next user action consume that terminal error merely to clear
		// the cache; replace it with a fresh broker in this same request.
		delete(provider.sessions, route.id)
	}
	processContext, cancel := context.WithTimeout(context.Background(), route.credentialBrokerLaunch.timeout)
	connection, processID, err := provider.host.startCredentialBroker(processContext, route, credentialBrokerRequest{
		Protocol: market.CredentialBrokerProtocolV1, Operation: "begin",
	})
	if err != nil {
		cancel()
		provider.mu.Unlock()
		return nil, fmt.Errorf("start connector credential broker: %w", err)
	}
	session := &credentialBrokerSession{cancel: cancel, changed: make(chan struct{})}
	provider.sessions[route.id] = session
	provider.mu.Unlock()
	go consumeAuthorizationEvents(route, connection, processID, session)
	return session, nil
}

func consumeAuthorizationEvents(
	route *connectorRoute,
	connection agentruntime.ProcessConnection,
	processID uint64,
	session *credentialBrokerSession,
) {
	defer session.cancel()
	defer route.releaseProcess(processID, connection)
	var stdout, stderr strings.Builder
	for {
		frame, err := receiveCredentialBrokerFrame(connection)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				session.fail(fmt.Errorf("receive connector credential broker event: %w", err))
			} else if !session.terminal() {
				session.fail(errors.New("connector credential broker exited before a terminal event"))
			}
			return
		}
		stdout.Write(frame.Stdout)
		stderr.Write(frame.Stderr)
		if stdout.Len()+stderr.Len() > 1<<20 {
			session.fail(errors.New("connector credential broker output exceeded its limit"))
			return
		}
		for {
			line, remaining, ok := strings.Cut(stdout.String(), "\n")
			if !ok {
				break
			}
			stdout.Reset()
			stdout.WriteString(remaining)
			if err := applyCredentialBrokerEvent(route, session, line); err != nil {
				session.fail(err)
				return
			}
		}
		if frame.ExitCode != nil {
			if trailing := strings.TrimSpace(stdout.String()); trailing != "" {
				if err := applyCredentialBrokerEvent(route, session, trailing); err != nil {
					session.fail(err)
					return
				}
			}
			if *frame.ExitCode != 0 && !session.terminal() {
				session.fail(fmt.Errorf("connector credential broker exited with code %d: %s", *frame.ExitCode, boundedBrokerMessage(stderr.String())))
			} else if !session.terminal() {
				session.fail(errors.New("connector credential broker exited before a terminal event"))
			}
			return
		}
	}
}

func applyCredentialBrokerEvent(route *connectorRoute, session *credentialBrokerSession, payload string) error {
	if strings.TrimSpace(payload) == "" {
		return nil
	}
	var event credentialBrokerEvent
	if err := decodeCredentialBrokerEvent(payload, &event); err != nil {
		return fmt.Errorf("decode connector credential broker event: %w", err)
	}
	switch event.Type {
	case "authorization_url":
		if !safeCredentialBrokerURL(event.URL, route.credentialBrokerLaunch.allowedHosts) {
			return errors.New("connector credential broker returned an unauthorized URL")
		}
		session.update(market.AuthorizationStatePending, event.URL, nil)
	case "connected":
		session.update(market.AuthorizationStateConnected, "", nil)
	case "error":
		return credentialBrokerEventError(event, "authorize")
	default:
		return fmt.Errorf("connector credential broker returned unsupported event type %q", event.Type)
	}
	return nil
}

func (host *Host) authorizationRoute(connector market.Connector) (*connectorRoute, error) {
	managed := connector.Release.Manifest.Implementation.ManagedStdio
	if host == nil || connector.Release.Manifest.Implementation.Kind != market.ImplementationKindManagedStdio ||
		connector.Release.Manifest.AuthorizationKind == "none" || managed == nil || managed.CredentialBroker == nil ||
		connector.Installation.State != market.InstallationStateInstalled {
		return nil, errors.New("managed connector authorization is unavailable")
	}
	route, _ := host.routes.Route(connectorRouteKey("default", connector.Key)).(*connectorRoute)
	if route == nil || !host.routeCurrent(route) || route.credentialBrokerLaunch == nil {
		return nil, errors.New("managed connector authorization route is unavailable")
	}
	return route, nil
}

func (host *Host) startCredentialBroker(
	ctx context.Context,
	route *connectorRoute,
	request credentialBrokerRequest,
) (agentruntime.ProcessConnection, uint64, error) {
	launch := route.credentialBrokerLaunch
	if launch == nil || request.Protocol != market.CredentialBrokerProtocolV1 ||
		(request.Operation != "begin" && request.Operation != "disconnect") {
		return nil, 0, errors.New("connector credential broker request is invalid")
	}
	spec := connectorruntime.ConnectorProcessSpec(route.connectionID, route.connectorKey, launch.language, launch.executable,
		launch.cwd, []string{launch.entrypoint}, launch.stateDir, route.userHome, launch.artifactTrees)
	cliLaunch, err := json.Marshal(launch.cliLaunch)
	if err != nil {
		return nil, 0, err
	}
	spec.Env = append(spec.Env,
		"TUTTI_CONNECTOR_CREDENTIAL_BROKER_PROTOCOL="+market.CredentialBrokerProtocolV1,
		"TUTTI_CONNECTOR_CLI_LAUNCH_JSON="+string(cliLaunch),
	)
	connection, processID, err := host.startProcess(ctx, route, spec, true)
	if err != nil {
		return nil, 0, err
	}
	payload, err := json.Marshal(request)
	if err == nil {
		err = connection.Send(append(payload, '\n'))
	}
	if err == nil {
		if graceful, ok := connection.(agentruntime.GracefulProcessConnection); ok {
			err = graceful.CloseInput()
		}
	}
	if err != nil {
		route.releaseProcess(processID, connection)
		return nil, 0, err
	}
	return connection, processID, nil
}

func receiveCredentialBrokerFrame(connection agentruntime.ProcessConnection) (agentruntime.ProcessFrame, error) {
	return connection.Recv()
}

func receiveCredentialBrokerFrameContext(ctx context.Context, connection agentruntime.ProcessConnection) (agentruntime.ProcessFrame, error) {
	if contextual, ok := connection.(agentruntime.ContextProcessConnection); ok {
		return contextual.RecvContext(ctx)
	}
	return connection.Recv()
}

func readCredentialBrokerTerminalEvent(ctx context.Context, connection agentruntime.ProcessConnection) (credentialBrokerEvent, error) {
	var output strings.Builder
	for {
		frame, err := receiveCredentialBrokerFrameContext(ctx, connection)
		if err != nil {
			return credentialBrokerEvent{}, err
		}
		output.Write(frame.Stdout)
		if output.Len() > 1<<20 {
			return credentialBrokerEvent{}, errors.New("connector credential broker output exceeded its limit")
		}
		for {
			line, remaining, ok := strings.Cut(output.String(), "\n")
			if !ok {
				break
			}
			output.Reset()
			output.WriteString(remaining)
			if strings.TrimSpace(line) == "" {
				continue
			}
			var event credentialBrokerEvent
			if err := decodeCredentialBrokerEvent(line, &event); err != nil {
				return credentialBrokerEvent{}, err
			}
			if event.Type == "disconnected" || event.Type == "error" {
				return event, nil
			}
			return credentialBrokerEvent{}, fmt.Errorf("unexpected credential broker disconnect event %q", event.Type)
		}
		if frame.ExitCode != nil {
			return credentialBrokerEvent{}, errors.New("connector credential broker exited before disconnect completed")
		}
	}
}

func decodeCredentialBrokerEvent(payload string, event *credentialBrokerEvent) error {
	decoder := json.NewDecoder(strings.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(event); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("credential broker event contains trailing JSON")
	}
	return nil
}

func safeCredentialBrokerURL(value string, allowedHosts map[string]struct{}) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Hostname() == "" || parsed.Port() != "" {
		return false
	}
	_, allowed := allowedHosts[strings.ToLower(parsed.Hostname())]
	return allowed
}

func credentialBrokerEventError(event credentialBrokerEvent, operation string) error {
	message := boundedBrokerMessage(event.Message)
	if message == "" {
		message = "connector credential broker reported an error"
	}
	if code := strings.TrimSpace(event.Code); code != "" {
		return fmt.Errorf("%s connector authorization (%s): %s", operation, code, message)
	}
	return fmt.Errorf("%s connector authorization: %s", operation, message)
}

func boundedBrokerMessage(message string) string {
	message = strings.TrimSpace(message)
	if len(message) > 4096 {
		message = message[len(message)-4096:]
	}
	return message
}

func (session *credentialBrokerSession) awaitInitialEvent(ctx context.Context) error {
	session.mu.Lock()
	version := session.version
	changed := session.changed
	session.mu.Unlock()
	if version != 0 {
		return nil
	}
	timer := time.NewTimer(credentialBrokerInitialEventTimeout)
	defer timer.Stop()
	select {
	case <-changed:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return errors.New("connector credential broker did not return an initial event")
	}
}

func (session *credentialBrokerSession) update(state market.AuthorizationState, authorizationURL string, err error) {
	session.mu.Lock()
	session.state = state
	session.url = authorizationURL
	session.err = err
	session.version++
	close(session.changed)
	session.changed = make(chan struct{})
	session.mu.Unlock()
}

func (session *credentialBrokerSession) fail(err error) {
	session.update(market.AuthorizationStateFailed, "", err)
}

func (session *credentialBrokerSession) snapshot() (market.AuthorizationState, string, error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.state, session.url, session.err
}

func (session *credentialBrokerSession) terminal() bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.state == market.AuthorizationStateConnected || session.err != nil
}

func (provider *managedCredentialAuthorizationProvider) takeAuthorizationSession(routeID string) *credentialBrokerSession {
	provider.mu.Lock()
	defer provider.mu.Unlock()
	session := provider.sessions[routeID]
	delete(provider.sessions, routeID)
	return session
}

func (provider *managedCredentialAuthorizationProvider) clearAuthorizationSession(routeID string, session *credentialBrokerSession) {
	provider.mu.Lock()
	if provider.sessions[routeID] == session {
		delete(provider.sessions, routeID)
	}
	provider.mu.Unlock()
}
