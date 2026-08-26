package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRunStandardACPSetupAuthenticatesWithFreshAdvertisedMethod(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Example Agent", "setup-session")
	transport.conn.authMethods = []map[string]any{{
		"id": "oauth-personal", "name": "Log in with Google", "description": "Google account",
	}}
	transport.conn.requireAuthentication = true
	transport.conn.authenticateResult = map[string]any{
		"_meta": map[string]any{
			"codebuddy.ai/userinfo": map[string]any{
				"userId": "user-1", "userName": "Ryan", "userNickname": "Rhinoc", "enterpriseName": "Tutti",
			},
		},
	}
	result, err := runStandardACPSetupTest(t, transport, "oauth-personal")
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != StandardACPSetupReady || len(result.AuthMethods) != 1 || result.AuthMethods[0].ID != "oauth-personal" {
		t.Fatalf("setup result = %#v", result)
	}
	if result.Account == nil || result.Account.ID != "user-1" || result.Account.DisplayName != "Rhinoc" ||
		result.Account.AuthMethodID != "oauth-personal" || result.Account.Organization != "Tutti" {
		t.Fatalf("authenticated account = %#v", result.Account)
	}
	if got := transport.conn.authenticatedMethodID(); got != "oauth-personal" {
		t.Fatalf("authenticated method id = %q", got)
	}
	if containsString(transport.specs[0].Env, "NO_BROWSER=1") {
		t.Fatal("interactive authenticate must allow the runtime to open a browser")
	}
}

func TestRunStandardACPSetupRejectsUnadvertisedMethod(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Example Agent", "setup-session")
	transport.conn.authMethods = []map[string]any{{"id": "oauth", "name": "OAuth"}}
	_, err := runStandardACPSetupTest(t, transport, "attacker-method")
	if !errors.Is(err, ErrACPAuthMethodUnavailable) {
		t.Fatalf("error = %v, want ErrACPAuthMethodUnavailable", err)
	}
	if got := transport.conn.authenticatedMethodID(); got != "" {
		t.Fatalf("authenticated method id = %q", got)
	}
}

func TestRunStandardACPSetupPreservesExplicitAuthenticationFailureWithoutTextInference(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Example Agent", "setup-session")
	transport.conn.authMethods = []map[string]any{{"id": "oauth", "name": "OAuth"}}
	transport.conn.authenticateError = &acpError{
		Code:    -32000,
		Message: "This account is not supported by this client",
	}
	result, err := runStandardACPSetupTest(t, transport, "oauth")
	if err == nil || !strings.Contains(err.Error(), "This account is not supported by this client") {
		t.Fatalf("error = %v, want provider authentication failure", err)
	}
	if result.Status != StandardACPSetupAuthRequired || len(result.AuthMethods) != 1 {
		t.Fatalf("setup result = %#v", result)
	}
}

func TestRunStandardACPSetupRejectsTerminalMethodWithoutAuthenticate(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Example Agent", "setup-session")
	transport.conn.authMethods = []map[string]any{{
		"id": "login", "name": "Login with Example account",
		"description": "Run `example login` in a terminal",
		"type":        "terminal", "args": []any{"login"},
	}}
	transport.conn.requireAuthentication = true
	result, err := runStandardACPSetupTest(t, transport, "login")
	if !errors.Is(err, ErrACPAuthMethodTerminal) {
		t.Fatalf("error = %v, want ErrACPAuthMethodTerminal", err)
	}
	if result.Status != StandardACPSetupAuthRequired || len(result.AuthMethods) != 1 {
		t.Fatalf("setup result = %#v", result)
	}
	method := result.AuthMethods[0]
	if method.Type != "terminal" || len(method.Args) != 1 || method.Args[0] != "login" {
		t.Fatalf("terminal auth method = %#v", method)
	}
	if got := transport.conn.authenticatedMethodID(); got != "" {
		t.Fatalf("authenticated method id = %q, want no ACP authenticate call", got)
	}
}

func TestRunStandardACPSetupParsesAuthMethodTypeAndArgs(t *testing.T) {
	t.Parallel()

	initializeResult := json.RawMessage(`{"authMethods":[
		{"id":"browser","name":"Browser","description":"d"},
		{"id":"login","name":"Terminal login","type":"terminal","args":["login","--device"]},
		{"id":"bad","name":"Bad","type":"terminal","args":["", "ok"]}
	]}`)
	methods := parseStandardACPAuthMethods(initializeResult)
	if len(methods) != 3 {
		t.Fatalf("auth methods = %#v", methods)
	}
	if methods[0].Type != "" || methods[0].Args != nil {
		t.Fatalf("browser method = %#v", methods[0])
	}
	if methods[1].Type != "terminal" || strings.Join(methods[1].Args, " ") != "login --device" {
		t.Fatalf("terminal method = %#v", methods[1])
	}
	if methods[2].Type != "terminal" || methods[2].Args != nil {
		t.Fatalf("method with invalid args = %#v", methods[2])
	}
}

func TestRunStandardACPSetupParsesAuthMethodTerminalMeta(t *testing.T) {
	t.Parallel()

	// Kimi Code declares the terminal login metadata inside the ACP _meta
	// extension, not as top-level type/args fields.
	initializeResult := json.RawMessage(`{"authMethods":[
		{"id":"login","name":"Login with Kimi account","description":"Run ` + "`kimi login`" + ` in a terminal",
			"_meta":{"terminal-auth":{"command":"/opt/kimi/bin/kimi","args":["login"],"label":"Kimi Code Login","env":{},"type":"terminal"}}},
		{"id":"both","name":"Both","type":"browser","args":["--top"],
			"_meta":{"terminal-auth":{"type":"terminal","args":["login"]}}},
		{"id":"weird","name":"Weird","_meta":{"other":{"type":"terminal"}}}
	]}`)
	methods := parseStandardACPAuthMethods(initializeResult)
	if len(methods) != 3 {
		t.Fatalf("auth methods = %#v", methods)
	}
	if methods[0].Type != "terminal" || len(methods[0].Args) != 1 || methods[0].Args[0] != "login" {
		t.Fatalf("meta terminal method = %#v", methods[0])
	}
	if methods[1].Type != "browser" || strings.Join(methods[1].Args, " ") != "--top" {
		t.Fatalf("top-level fields must win over _meta = %#v", methods[1])
	}
	if methods[2].Type != "" || methods[2].Args != nil {
		t.Fatalf("unrelated _meta must be ignored = %#v", methods[2])
	}
}

func TestRunStandardACPSetupRejectsTerminalMetaMethodWithoutAuthenticate(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Example Agent", "setup-session")
	transport.conn.authMethods = []map[string]any{{
		"id": "login", "name": "Login with Example account",
		"description": "Run `example login` in a terminal",
		"_meta": map[string]any{
			"terminal-auth": map[string]any{"type": "terminal", "args": []any{"login"}},
		},
	}}
	transport.conn.requireAuthentication = true
	result, err := runStandardACPSetupTest(t, transport, "login")
	if !errors.Is(err, ErrACPAuthMethodTerminal) {
		t.Fatalf("error = %v, want ErrACPAuthMethodTerminal", err)
	}
	if result.Status != StandardACPSetupAuthRequired || len(result.AuthMethods) != 1 {
		t.Fatalf("setup result = %#v", result)
	}
	if got := transport.conn.authenticatedMethodID(); got != "" {
		t.Fatalf("authenticated method id = %q, want no ACP authenticate call", got)
	}
}

func TestRunStandardACPSetupFlagsSessionWithoutUsableModel(t *testing.T) {
	t.Parallel()

	// Kimi Code with a saved OAuth token but an unseeded model config:
	// session/new succeeds yet advertises zero models, and every prompt would
	// fail. The probe must keep the target in auth_required so the gate
	// re-offers the terminal login that seeds the config.
	transport := newStandardACPTransport("Example Agent", "setup-session")
	transport.conn.authMethods = []map[string]any{{
		"id": "login", "name": "Login with Example account",
		"_meta": map[string]any{
			"terminal-auth": map[string]any{"type": "terminal", "args": []any{"login"}},
		},
	}}
	transport.conn.models = map[string]any{"availableModels": []any{}, "currentModelId": ""}
	result, err := runStandardACPSetupTest(t, transport, "")
	if err != nil {
		t.Fatalf("probe without method must not fail hard: %v", err)
	}
	if result.Status != StandardACPSetupAuthRequired || len(result.AuthMethods) != 1 {
		t.Fatalf("setup result = %#v", result)
	}
	if method := result.AuthMethods[0]; method.Type != "terminal" || len(method.Args) != 1 || method.Args[0] != "login" {
		t.Fatalf("terminal auth method = %#v", method)
	}
	if transport.conn.lastNewSessionParams == nil {
		t.Fatal("probe must verify readiness through session/new")
	}
}

func TestRunStandardACPSetupReadyWhenTerminalMethodRemainsAdvertised(t *testing.T) {
	t.Parallel()

	// Kimi Code continues advertising its terminal login method after setup.
	// The method catalog is not an authentication verdict: a usable session/new
	// result remains the authoritative ready signal.
	transport := newStandardACPTransport("Example Agent", "setup-session")
	transport.conn.authMethods = []map[string]any{{
		"id": "login", "name": "Login with Example account",
		"type": "terminal", "args": []any{"login"},
	}}
	transport.conn.models = map[string]any{
		"availableModels": []any{map[string]any{"modelId": "example-model", "name": "Example Model"}},
		"currentModelId":  "example-model",
	}

	result, err := runStandardACPSetupTest(t, transport, "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != StandardACPSetupReady || len(result.AuthMethods) != 1 {
		t.Fatalf("setup result = %#v", result)
	}
	if transport.conn.lastNewSessionParams == nil {
		t.Fatal("probe must verify readiness through session/new")
	}
	if got := transport.conn.authenticatedMethodID(); got != "" {
		t.Fatalf("authenticated method id = %q, want no ACP authenticate call", got)
	}
}

func TestStandardACPSetupSessionNewAuthCompatibilityIsExact(t *testing.T) {
	authErr := &acpCallError{Method: acpMethodNewSession, Err: acpError{
		Code: -32000, Message: "authentication required",
	}}
	if !standardACPSetupSessionNewAuthRejected(authErr) {
		t.Fatal("exact setup authentication rejection was not recognized")
	}

	providerErr := &acpCallError{Method: acpMethodNewSession, Err: acpError{
		Code: -32000, Message: "server overloaded; relay returned 524",
	}}
	if standardACPSetupSessionNewAuthRejected(providerErr) {
		t.Fatal("unrelated provider failure must not become setup auth_required")
	}
}

func TestRunStandardACPSetupOffersTerminalConfigurationForMissingProvider(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Example Agent", "setup-session")
	transport.conn.authMethods = []map[string]any{{
		"id": "agent-setup", "name": "Configure Example Agent",
		"type": "terminal", "args": []any{"--setup"},
	}}
	transport.conn.newSessionError = &acpError{
		Code:    -32603,
		Message: "Internal error",
		Data:    json.RawMessage(`{"details":"No LLM provider configured. Run example setup for first-time configuration."}`),
	}

	result, err := runStandardACPSetupTest(t, transport, "")
	if err != nil {
		t.Fatalf("probe without method must expose configuration instead of failing: %v", err)
	}
	if result.Status != StandardACPSetupAuthRequired || len(result.AuthMethods) != 1 {
		t.Fatalf("setup result = %#v", result)
	}
	if method := result.AuthMethods[0]; method.ID != "agent-setup" || method.Type != "terminal" ||
		len(method.Args) != 1 || method.Args[0] != "--setup" {
		t.Fatalf("terminal configuration method = %#v", method)
	}
	if transport.conn.lastNewSessionParams == nil {
		t.Fatal("probe must inspect session/new before classifying missing configuration")
	}
}

func TestStandardACPSetupMissingProviderRequiresAdvertisedTerminalConfiguration(t *testing.T) {
	t.Parallel()

	err := errors.New("No LLM provider configured")
	if standardACPSetupNeedsConfiguration(err, nil) {
		t.Fatal("missing provider without a terminal configuration method must remain a runtime failure")
	}
	if standardACPSetupNeedsConfiguration(errors.New("provider request failed"), []StandardACPAuthMethod{{
		ID: "setup", Type: "terminal", Args: []string{"--setup"},
	}}) {
		t.Fatal("unrelated provider failures must remain runtime failures")
	}
}

func TestStandardACPSetupSessionNewTimeoutWithTerminalConfigurationRequiresAuth(t *testing.T) {
	t.Parallel()

	err := &acpCallTimeoutError{Method: acpMethodNewSession, Timeout: time.Minute}
	methods := []StandardACPAuthMethod{{ID: "anthropic", Name: "Anthropic"}, {
		ID: "hermes-setup", Name: "Configure Hermes", Type: "terminal", Args: []string{"--setup"},
	}}
	if !standardACPSetupSessionNewTimedOut(err) {
		t.Fatal("session/new timeout was not recognized")
	}
	if !standardACPSetupHasInteractiveAuth(methods) {
		t.Fatal("terminal setup method was not recognized")
	}
}

func TestRunStandardACPSetupReadyWithSeededModels(t *testing.T) {
	t.Parallel()

	transport := newStandardACPTransport("Example Agent", "setup-session")
	transport.conn.models = map[string]any{
		"availableModels": []any{map[string]any{"modelId": "example-model", "name": "Example Model"}},
		"currentModelId":  "example-model",
	}
	result, err := runStandardACPSetupTest(t, transport, "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != StandardACPSetupReady {
		t.Fatalf("setup result = %#v", result)
	}
}

func TestACPSessionHasNoUsableModel(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"empty list and no current model", `{"models":{"availableModels":[],"currentModelId":""}}`, true},
		{"empty config option model selector", `{"configOptions":[{"id":"model","category":"model","currentValue":"","options":[]}]}`, true},
		{"empty categorized model selector", `{"configOptions":[{"id":"model_choice","category":"model","currentValue":null,"options":[]}]}`, true},
		{"populated config option model selector", `{"configOptions":[{"id":"model","currentValue":"m","options":[{"name":"M","value":"m"}]}]}`, false},
		{"empty options with current config model", `{"configOptions":[{"id":"model","currentValue":"m","options":[]}]}`, false},
		{"unrelated empty config option", `{"configOptions":[{"id":"sandbox","currentValue":"","options":[]}]}`, false},
		{"populated list", `{"models":{"availableModels":[{"modelId":"m"}],"currentModelId":"m"}}`, false},
		{"empty list but current model set", `{"models":{"availableModels":[],"currentModelId":"m"}}`, false},
		{"models state without list", `{"models":{"currentModelId":"m"}}`, false},
		{"no models state", `{"sessionId":"s"}`, false},
		{"null models state", `{"models":null}`, false},
	}
	for _, tc := range cases {
		if got := acpSessionHasNoUsableModel(json.RawMessage(tc.raw)); got != tc.want {
			t.Fatalf("%s: acpSessionHasNoUsableModel = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func runStandardACPSetupTest(t *testing.T, transport *standardACPTransport, methodID string) (StandardACPSetupResult, error) {
	t.Helper()
	return RunStandardACPSetup(
		context.Background(),
		StandardACPAdapterConfig{Provider: "acp:example", Name: "example-acp", Command: []string{"example", "--acp"}},
		transport,
		LegacyHostMetadata(),
		standardTestSession("acp:example"),
		methodID,
	)
}
