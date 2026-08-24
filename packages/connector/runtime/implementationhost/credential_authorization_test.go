package implementationhost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	connectorruntime "github.com/tutti-os/tutti/packages/connector/runtime"
)

func TestAttachCredentialBrokerPreservesEmptyNativeCLIArguments(t *testing.T) {
	preparedPath := t.TempDir()
	if err := os.WriteFile(filepath.Join(preparedPath, "credential-broker.mjs"), []byte("export {};\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	route := &connectorRoute{cliLaunch: &managedCLILaunch{
		arguments: []string{}, cwd: preparedPath,
		executable: connectorruntime.ConnectorExecutable{Path: "/managed/lark-cli"},
	}}
	err := (&Host{}).attachCredentialBroker(route, &market.ManagedCredentialBroker{
		Entrypoint: "credential-broker.mjs", TimeoutMS: 300_000,
	}, market.PreparedArtifactReceipt{PreparedPath: preparedPath}, connectorruntime.ConnectorExecutable{}, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(route.credentialBrokerLaunch.cliLaunch)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), `"arguments":[]`) {
		t.Fatalf("credential broker CLI launch = %s, want empty JSON array", payload)
	}
}

type credentialAuthorizationHostStub struct {
	mu          sync.Mutex
	route       *connectorRoute
	connections []agentruntime.ProcessConnection
	requests    []credentialBrokerRequest
	observed    []market.AuthorizationState
}

func (stub *credentialAuthorizationHostStub) authorizationRoute(context.Context, market.OperationScope, market.Connector) (*connectorRoute, error) {
	if stub.route == nil {
		return nil, errors.New("route unavailable")
	}
	return stub.route, nil
}

func (stub *credentialAuthorizationHostStub) observeAuthorization(_ *connectorRoute, state market.AuthorizationState) {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	stub.observed = append(stub.observed, state)
}

func (stub *credentialAuthorizationHostStub) authorizationObservations() []market.AuthorizationState {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	return append([]market.AuthorizationState(nil), stub.observed...)
}

func (*credentialAuthorizationHostStub) releaseAuthorizationRoute(*connectorRoute) {}

func (stub *credentialAuthorizationHostStub) startCredentialBroker(
	_ context.Context,
	_ *connectorRoute,
	request credentialBrokerRequest,
) (agentruntime.ProcessConnection, uint64, error) {
	stub.requests = append(stub.requests, request)
	if len(stub.connections) == 0 {
		return nil, 0, errors.New("unexpected credential broker start")
	}
	connection := stub.connections[0]
	stub.connections = stub.connections[1:]
	return connection, uint64(len(stub.requests)), nil
}

type credentialBrokerConnection struct {
	frames    chan agentruntime.ProcessFrame
	closed    chan struct{}
	closeOnce sync.Once
}

func newCredentialBrokerConnection() *credentialBrokerConnection {
	return &credentialBrokerConnection{frames: make(chan agentruntime.ProcessFrame, 8), closed: make(chan struct{})}
}

func (*credentialBrokerConnection) Send([]byte) error { return nil }
func (*credentialBrokerConnection) CloseInput() error { return nil }
func (*credentialBrokerConnection) Terminate() error  { return nil }
func (*credentialBrokerConnection) Kill() error       { return nil }

func (connection *credentialBrokerConnection) Close() error {
	connection.closeOnce.Do(func() {
		close(connection.closed)
		close(connection.frames)
	})
	return nil
}

func (connection *credentialBrokerConnection) Recv() (agentruntime.ProcessFrame, error) {
	frame, ok := <-connection.frames
	if !ok {
		return agentruntime.ProcessFrame{}, io.EOF
	}
	return frame, nil
}

func (connection *credentialBrokerConnection) RecvContext(ctx context.Context) (agentruntime.ProcessFrame, error) {
	select {
	case <-ctx.Done():
		return agentruntime.ProcessFrame{}, ctx.Err()
	case frame, ok := <-connection.frames:
		if !ok {
			return agentruntime.ProcessFrame{}, io.EOF
		}
		return frame, nil
	}
}

func TestManagedCredentialAuthorizationContinuesConnectorOwnedBroker(t *testing.T) {
	connection := newCredentialBrokerConnection()
	host := &credentialAuthorizationHostStub{
		route: &connectorRoute{id: "default\x00lark-cli", credentialBrokerLaunch: &managedCredentialBrokerLaunch{
			timeout: 5 * time.Minute,
			allowedHosts: map[string]struct{}{
				"open.feishu.cn":     {},
				"accounts.feishu.cn": {},
			},
		}},
		connections: []agentruntime.ProcessConnection{connection},
	}
	provider := newManagedCredentialAuthorizationProvider(host)
	request := market.AuthorizationStartRequest{OperationID: "authorize-1", Connector: market.Connector{Key: "lark-cli"}}

	firstResult := make(chan market.AuthorizationSession, 1)
	firstError := make(chan error, 1)
	go func() {
		session, err := provider.Begin(context.Background(), request)
		firstResult <- session
		firstError <- err
	}()
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://open.feishu.cn/page/cli?user_code=opaque"}` + "\n")}
	if err := <-firstError; err != nil {
		t.Fatal(err)
	}
	first := <-firstResult
	if first.State != market.AuthorizationStatePending || first.AuthorizationURL != "https://open.feishu.cn/page/cli?user_code=opaque" {
		t.Fatalf("first session = %#v", first)
	}
	if first.StepRevision != 1 {
		t.Fatalf("first step revision = %d, want 1", first.StepRevision)
	}

	secondResult := make(chan market.AuthorizationSession, 1)
	secondError := make(chan error, 1)
	go func() {
		continuedRequest := request
		continuedRequest.AfterStepRevision = first.StepRevision
		session, err := provider.Begin(context.Background(), continuedRequest)
		secondResult <- session
		secondError <- err
	}()
	select {
	case result := <-secondResult:
		t.Fatalf("continuation returned the current step before a later event: %#v", result)
	case <-time.After(20 * time.Millisecond):
	}
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://accounts.feishu.cn/device?user_code=user"}` + "\n")}
	if err := <-secondError; err != nil {
		t.Fatal(err)
	}
	second := <-secondResult
	if second.State != market.AuthorizationStatePending {
		t.Fatalf("second session = %#v", second)
	}
	if second.AuthorizationURL != "https://accounts.feishu.cn/device?user_code=user" || second.StepRevision != 2 {
		t.Fatalf("second step = %#v", second)
	}

	exitCode := 0
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"connected"}` + "\n"), ExitCode: &exitCode}
	terminalRequest := request
	terminalRequest.AfterStepRevision = second.StepRevision
	connected := awaitAuthorizationSession(t, provider, terminalRequest, "")
	if connected.State != market.AuthorizationStateConnected {
		t.Fatalf("connected session = %#v", connected)
	}
	if connected.StepRevision != 3 {
		t.Fatalf("connected step revision = %d, want 3", connected.StepRevision)
	}
	if !reflect.DeepEqual(host.requests, []credentialBrokerRequest{{Protocol: market.CredentialBrokerProtocolV1, Operation: "begin"}}) {
		t.Fatalf("broker requests = %#v", host.requests)
	}
	observed := awaitAuthorizationObservations(t, host, 3)
	if !reflect.DeepEqual(observed, []market.AuthorizationState{market.AuthorizationStatePending, market.AuthorizationStatePending, market.AuthorizationStateConnected}) {
		t.Fatalf("authorization observations = %#v", observed)
	}
}

func TestManagedCredentialAuthorizationReturnsDeviceCodeFromBroker(t *testing.T) {
	connection := newCredentialBrokerConnection()
	host := &credentialAuthorizationHostStub{
		route: &connectorRoute{id: "default\x00github-cli", credentialBrokerLaunch: &managedCredentialBrokerLaunch{
			timeout: 5 * time.Minute, allowedHosts: map[string]struct{}{"github.com": {}},
		}},
		connections: []agentruntime.ProcessConnection{connection},
	}
	provider := newManagedCredentialAuthorizationProvider(host)
	result := make(chan market.AuthorizationSession, 1)
	resultErr := make(chan error, 1)
	go func() {
		session, err := provider.Begin(context.Background(), market.AuthorizationStartRequest{
			OperationID: "authorize-github", Connector: market.Connector{Key: "github-cli"},
			AfterStepRevision: 4, StepRevisionBase: 4,
		})
		result <- session
		resultErr <- err
	}()
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://github.com/login/device","code":"ABCD-EFGH"}` + "\n")}

	if err := <-resultErr; err != nil {
		t.Fatal(err)
	}
	session := <-result
	if session.AuthorizationURL != "https://github.com/login/device" || session.UserCode != "ABCD-EFGH" || session.StepRevision != 5 {
		t.Fatalf("authorization session = %#v", session)
	}
}

func TestManagedCredentialAuthorizationDisconnectUsesBrokerProtocol(t *testing.T) {
	exitCode := 0
	connection := newCredentialBrokerConnection()
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"disconnected"}` + "\n"), ExitCode: &exitCode}
	host := &credentialAuthorizationHostStub{
		route:       &connectorRoute{id: "default\x00lark-cli", credentialBrokerLaunch: &managedCredentialBrokerLaunch{timeout: 5 * time.Minute}},
		connections: []agentruntime.ProcessConnection{connection},
	}
	provider := newManagedCredentialAuthorizationProvider(host)
	err := provider.Disconnect(context.Background(), market.AuthorizationDisconnectRequest{Connector: market.Connector{Key: "lark-cli"}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(host.requests, []credentialBrokerRequest{{Protocol: market.CredentialBrokerProtocolV1, Operation: "disconnect"}}) {
		t.Fatalf("broker requests = %#v", host.requests)
	}
	observed := awaitAuthorizationObservations(t, host, 1)
	if !reflect.DeepEqual(observed, []market.AuthorizationState{market.AuthorizationStateDisconnected}) {
		t.Fatalf("authorization observations = %#v", observed)
	}
}

func TestManagedCredentialAuthorizationInspectReturnsFencedObservation(t *testing.T) {
	exitCode := 0
	connection := newCredentialBrokerConnection()
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"expired","code":"token_expired","message":"login expired"}` + "\n"), ExitCode: &exitCode}
	host := &credentialAuthorizationHostStub{
		route: &connectorRoute{id: "account-1\x00lark-cli", connectorKey: "lark-cli", connectionID: "account-1",
			releaseDigest: strings.Repeat("a", 64), credentialBrokerLaunch: &managedCredentialBrokerLaunch{timeout: 5 * time.Minute}},
		connections: []agentruntime.ProcessConnection{connection},
	}
	provider := newManagedCredentialAuthorizationProvider(host)
	connector := market.Connector{Key: "lark-cli", Release: market.Release{ReleaseDigest: strings.Repeat("a", 64)}}
	observation, err := provider.Inspect(context.Background(), market.AuthorizationInspectRequest{
		Scope: market.OperationScope{AccountID: "user-1"}, Connector: connector,
		AccountGeneration: 3, VMAssignmentID: "vm-1", AuthorizationSessionID: "auth-1",
		AuthorizationGeneration: 4, DesktopBootEpoch: "desktop-1", GuestBootID: "guest-1",
		RuntimeEpoch: "runtime-1", StateRevision: 9,
	})
	if err != nil {
		t.Fatal(err)
	}
	if observation.State != market.AuthorizationObservationExpired || observation.FailureCode != "token_expired" ||
		observation.AccountID != "user-1" || observation.AccountGeneration != 3 || observation.VMAssignmentID != "vm-1" ||
		observation.ConnectorKey != "lark-cli" || observation.ConnectionID != "account-1" ||
		observation.ReleaseDigest != strings.Repeat("a", 64) || observation.StateRevision != 9 || observation.ObservedAt.IsZero() {
		t.Fatalf("observation = %#v", observation)
	}
	if !reflect.DeepEqual(host.requests, []credentialBrokerRequest{{Protocol: market.CredentialBrokerProtocolV1, Operation: "inspect"}}) {
		t.Fatalf("broker requests = %#v", host.requests)
	}
}

func TestInstallationTargetsReleaseAcceptsOnlyActiveCurrentOrCandidate(t *testing.T) {
	tests := []struct {
		name          string
		installation  market.Installation
		releaseDigest string
		want          bool
	}{
		{
			name: "installed current release",
			installation: market.Installation{
				State: market.InstallationStateInstalled, InstalledReleaseDigest: "current",
			},
			releaseDigest: "current",
			want:          true,
		},
		{
			name: "installing candidate release",
			installation: market.Installation{
				State: market.InstallationStateInstalling, CandidateReleaseDigest: "candidate",
			},
			releaseDigest: "candidate",
			want:          true,
		},
		{
			name: "updating candidate release",
			installation: market.Installation{
				State: market.InstallationStateUpdating, InstalledReleaseDigest: "current", CandidateReleaseDigest: "candidate",
			},
			releaseDigest: "candidate",
			want:          true,
		},
		{
			name: "updating superseded current release",
			installation: market.Installation{
				State: market.InstallationStateUpdating, InstalledReleaseDigest: "current", CandidateReleaseDigest: "candidate",
			},
			releaseDigest: "current",
		},
		{
			name: "failed candidate release",
			installation: market.Installation{
				State: market.InstallationStateFailed, CandidateReleaseDigest: "candidate",
			},
			releaseDigest: "candidate",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := installationTargetsRelease(test.installation, test.releaseDigest); got != test.want {
				t.Fatalf("installationTargetsRelease() = %v, want %v", got, test.want)
			}
		})
	}
}

func awaitAuthorizationObservations(t *testing.T, host *credentialAuthorizationHostStub, count int) []market.AuthorizationState {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		observed := host.authorizationObservations()
		if len(observed) >= count {
			return observed
		}
		if time.Now().After(deadline) {
			t.Fatalf("authorization observations = %#v, want at least %d", observed, count)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestManagedCredentialAuthorizationSharesOneBrokerAcrossConcurrentBegins(t *testing.T) {
	connection := newCredentialBrokerConnection()
	host := &credentialAuthorizationHostStub{
		route: &connectorRoute{id: "default\x00example", credentialBrokerLaunch: &managedCredentialBrokerLaunch{
			timeout: 5 * time.Minute, allowedHosts: map[string]struct{}{"accounts.example.com": {}},
		}},
		connections: []agentruntime.ProcessConnection{connection},
	}
	provider := newManagedCredentialAuthorizationProvider(host)
	results := make(chan market.AuthorizationSession, 2)
	errors := make(chan error, 2)
	for index := 0; index < 2; index++ {
		go func() {
			session, err := provider.Begin(context.Background(), market.AuthorizationStartRequest{
				OperationID: "authorize", Connector: market.Connector{Key: "example"},
			})
			results <- session
			errors <- err
		}()
	}
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://accounts.example.com/device"}` + "\n")}
	for index := 0; index < 2; index++ {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
		if result := <-results; result.AuthorizationURL != "https://accounts.example.com/device" {
			t.Fatalf("authorization session = %#v", result)
		}
	}
	if len(host.requests) != 1 {
		t.Fatalf("credential broker starts = %d, want 1", len(host.requests))
	}
}

func TestManagedCredentialAuthorizationRestartsFailedBrokerOnFirstRetry(t *testing.T) {
	failedConnection := newCredentialBrokerConnection()
	retryConnection := newCredentialBrokerConnection()
	route := &connectorRoute{id: "default\x00example", credentialBrokerLaunch: &managedCredentialBrokerLaunch{
		timeout: 5 * time.Minute, allowedHosts: map[string]struct{}{"accounts.example.com": {}},
	}}
	host := &credentialAuthorizationHostStub{
		route: route, connections: []agentruntime.ProcessConnection{failedConnection, retryConnection},
	}
	provider := newManagedCredentialAuthorizationProvider(host)
	firstRequest := market.AuthorizationStartRequest{OperationID: "authorize-first", Connector: market.Connector{Key: "example"}}
	firstResult := make(chan market.AuthorizationSession, 1)
	firstError := make(chan error, 1)
	go func() {
		session, err := provider.Begin(context.Background(), firstRequest)
		firstResult <- session
		firstError <- err
	}()
	failedConnection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://accounts.example.com/first"}` + "\n")}
	if err := <-firstError; err != nil {
		t.Fatal(err)
	}
	if result := <-firstResult; result.AuthorizationURL != "https://accounts.example.com/first" {
		t.Fatalf("first authorization session = %#v", result)
	}
	exitCode := 1
	failedConnection.frames <- agentruntime.ProcessFrame{Stderr: []byte("broker failed"), ExitCode: &exitCode}
	awaitCachedAuthorizationFailure(t, provider, firstRequest.OperationID)

	retryConnection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://accounts.example.com/retry"}` + "\n")}
	retry, err := provider.Begin(context.Background(), market.AuthorizationStartRequest{
		OperationID: "authorize-retry", Connector: market.Connector{Key: "example"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if retry.AuthorizationURL != "https://accounts.example.com/retry" {
		t.Fatalf("retry authorization session = %#v", retry)
	}
	if len(host.requests) != 2 {
		t.Fatalf("credential broker starts = %d, want 2", len(host.requests))
	}
}

func TestManagedCredentialAuthorizationCancelTerminatesAndWaitsForBrokerExit(t *testing.T) {
	connection := newCredentialBrokerConnection()
	route := &connectorRoute{id: "default\x00dingtalk-cli", credentialBrokerLaunch: &managedCredentialBrokerLaunch{
		timeout: 5 * time.Minute, allowedHosts: map[string]struct{}{"login.dingtalk.com": {}},
	}}
	host := &credentialAuthorizationHostStub{route: route, connections: []agentruntime.ProcessConnection{connection}}
	provider := newManagedCredentialAuthorizationProvider(host)
	request := market.AuthorizationStartRequest{OperationID: "authorize-a", Connector: market.Connector{Key: "dingtalk-cli"}}
	beginDone := make(chan error, 1)
	go func() {
		_, err := provider.Begin(context.Background(), request)
		beginDone <- err
	}()
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://login.dingtalk.com/oauth"}` + "\n")}
	if err := <-beginDone; err != nil {
		t.Fatal(err)
	}

	cancelDone := make(chan error, 1)
	go func() {
		cancelDone <- provider.Cancel(context.Background(), market.AuthorizationCancelRequest{OperationID: request.OperationID})
	}()
	select {
	case <-connection.closed:
	case <-time.After(time.Second):
		t.Fatal("cancel did not close the credential broker connection")
	}
	select {
	case err := <-cancelDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancel did not wait for credential broker termination")
	}
	provider.mu.Lock()
	if provider.sessions[request.OperationID] != nil || provider.activeByRoute[route.id] != "" {
		t.Fatalf("canceled session remained active: sessions=%#v routes=%#v", provider.sessions, provider.activeByRoute)
	}
	provider.mu.Unlock()
	if observed := host.authorizationObservations(); !reflect.DeepEqual(observed, []market.AuthorizationState{market.AuthorizationStatePending}) {
		t.Fatalf("authorization observations after cancel = %#v", observed)
	}
}

func awaitCachedAuthorizationFailure(t *testing.T, provider *managedCredentialAuthorizationProvider, operationID string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		provider.mu.Lock()
		session := provider.sessions[operationID]
		provider.mu.Unlock()
		if session != nil {
			_, _, _, _, err := session.snapshot()
			if err != nil {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("credential broker session did not fail")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestManagedCredentialAuthorizationRejectsUntrustedURL(t *testing.T) {
	connection := newCredentialBrokerConnection()
	host := &credentialAuthorizationHostStub{
		route: &connectorRoute{id: "default\x00example", credentialBrokerLaunch: &managedCredentialBrokerLaunch{
			timeout: 5 * time.Minute, allowedHosts: map[string]struct{}{"accounts.example.com": {}},
		}},
		connections: []agentruntime.ProcessConnection{connection},
	}
	provider := newManagedCredentialAuthorizationProvider(host)
	result := make(chan error, 1)
	go func() {
		_, err := provider.Begin(context.Background(), market.AuthorizationStartRequest{
			OperationID: "authorize-unsafe", Connector: market.Connector{Key: "example"},
		})
		result <- err
	}()
	connection.frames <- agentruntime.ProcessFrame{Stdout: []byte(`{"type":"authorization_url","url":"https://accounts.example.com.attacker.test/login"}` + "\n")}
	if err := <-result; err == nil {
		t.Fatal("untrusted authorization URL was accepted")
	}
}

func awaitAuthorizationSession(
	t *testing.T,
	provider *managedCredentialAuthorizationProvider,
	request market.AuthorizationStartRequest,
	wantedURL string,
) market.AuthorizationSession {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		session, err := provider.Begin(context.Background(), request)
		if err != nil {
			t.Fatal(err)
		}
		if session.AuthorizationURL == wantedURL &&
			(wantedURL != "" || session.State == market.AuthorizationStateConnected) {
			return session
		}
		if time.Now().After(deadline) {
			t.Fatalf("authorization session did not reach URL %q: %#v", wantedURL, session)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestSafeCredentialBrokerURLRequiresExactHTTPSHost(t *testing.T) {
	allowed := map[string]struct{}{"accounts.feishu.cn": {}}
	if !safeCredentialBrokerURL("https://accounts.feishu.cn/device", allowed) {
		t.Fatal("allowed credential broker URL was rejected")
	}
	for _, value := range []string{
		"http://accounts.feishu.cn/device",
		"https://accounts.feishu.cn.attacker.test/device",
		"https://user@accounts.feishu.cn/device",
		"https://accounts.feishu.cn:444/device",
	} {
		if safeCredentialBrokerURL(value, allowed) {
			t.Fatalf("unsafe credential broker URL was accepted: %s", value)
		}
	}
}
