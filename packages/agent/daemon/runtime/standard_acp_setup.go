package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var ErrACPAuthMethodUnavailable = errors.New("ACP authentication method is unavailable")

var standardACPUnconfiguredProviderPattern = regexp.MustCompile(
	`(?i)\bno (?:llm|model|inference) provider configured\b`,
)

// ErrACPAuthMethodTerminal marks authentication methods of type "terminal".
// The ACP authenticate request would run the provider's interactive CLI login
// inside a headless background process where it can never complete, so setup
// rejects it immediately instead of blocking until the authenticate timeout.
// Keep the message free of words matched by the auth-failure classifier
// (login, token, credentials, ...) so it is not reclassified as an auth gate.
var ErrACPAuthMethodTerminal = errors.New("ACP auth method requires an interactive terminal")

// ErrACPSetupNoUsableModel marks an agent whose session/new succeeds but
// advertises a models state with zero available models and no current model.
// Kimi Code reaches this state when its OAuth login saved a token without
// seeding the model config (~/.kimi/config.toml): the token check passes, the
// session is created, and every prompt then fails. The setup probe treats it
// as auth_required so the gate keeps offering the terminal login that seeds
// the config. Keep the message free of words matched by the auth-failure
// classifier so only the explicit errors.Is mapping classifies it.
var ErrACPSetupNoUsableModel = errors.New("ACP agent created a session without any usable model")

type StandardACPSetupStatus string

const (
	StandardACPSetupReady        StandardACPSetupStatus = "ready"
	StandardACPSetupAuthRequired StandardACPSetupStatus = "auth_required"
)

type StandardACPAuthMethod struct {
	ID          string
	Name        string
	Description string
	// Type is the provider-declared method kind (for example "terminal").
	// Empty means the provider did not declare one; such methods are driven
	// through the ACP authenticate request as before.
	Type string
	// Args are the provider-declared CLI arguments for terminal-type methods
	// (for example ["login"] meaning `<agent> login`).
	Args []string
}

type StandardACPSetupResult struct {
	Status      StandardACPSetupStatus
	AuthMethods []StandardACPAuthMethod
	Account     *StandardACPAuthenticatedAccount
}

type StandardACPAuthenticatedAccount struct {
	ID           string
	DisplayName  string
	AuthMethodID string
	Organization string
}

// RunStandardACPSetup performs one setup-only initialize/session-new probe.
// When methodID is set, the method is first validated against the fresh
// initialize response and sent through ACP authenticate on the same process.
func RunStandardACPSetup(
	ctx context.Context,
	config StandardACPAdapterConfig,
	transport ProcessTransport,
	host HostMetadata,
	session Session,
	methodID string,
) (StandardACPSetupResult, error) {
	// Setup probes may be the first cold start of a managed Python runtime.
	// Keep the longer timeout scoped to discovery/authentication; normal
	// interactive ACP sessions retain the regular startup timeout.
	config.StartupTimeout = 60 * time.Second
	adapterValue, err := NewStandardACPAdapter(config, transport, host)
	if err != nil {
		return StandardACPSetupResult{}, err
	}
	adapter := adapterValue.(*standardACPAdapter)
	methodID = strings.TrimSpace(methodID)
	var methods []StandardACPAuthMethod
	var account *StandardACPAuthenticatedAccount
	adapter.config.validateNewSessionResult = func(newSessionResult json.RawMessage) error {
		if acpSessionHasNoUsableModel(newSessionResult) {
			return ErrACPSetupNoUsableModel
		}
		return nil
	}
	adapter.config.beforeNewSession = func(ctx context.Context, client *acpClient, session Session, initializeResult json.RawMessage) error {
		methods = parseStandardACPAuthMethods(initializeResult)
		if methodID == "" {
			return nil
		}
		method := findStandardACPAuthMethod(methods, methodID)
		if method == nil {
			return fmt.Errorf("%w: %s", ErrACPAuthMethodUnavailable, methodID)
		}
		if method.Type == "terminal" {
			return fmt.Errorf("%w: %s", ErrACPAuthMethodTerminal, methodID)
		}
		result, err := client.CallWithTimeout(
			ctx,
			10*time.Minute,
			acpMethodAuthenticate,
			map[string]any{"methodId": methodID},
			func(ctx context.Context, message acpMessage) error {
				_, err := adapter.handleACPMessage(ctx, client, session, "", message, nil, nil, nil)
				return err
			},
		)
		if err == nil {
			account = parseStandardACPAuthenticatedAccount(result, methodID)
		}
		return err
	}
	if methodID != "" {
		adapter.config.env = func(session Session) []string {
			result := standardACPEnv(session, host)
			for index, value := range result {
				if value == "NO_BROWSER=1" {
					return append(result[:index:index], result[index+1:]...)
				}
			}
			return result
		}
	}
	if _, err := adapter.Start(ctx, session); err != nil {
		if errors.Is(err, ErrACPAuthMethodTerminal) {
			return StandardACPSetupResult{Status: StandardACPSetupAuthRequired, AuthMethods: methods}, err
		}
		if errors.Is(err, ErrACPSetupNoUsableModel) {
			if methodID != "" {
				return StandardACPSetupResult{Status: StandardACPSetupAuthRequired, AuthMethods: methods}, err
			}
			return StandardACPSetupResult{Status: StandardACPSetupAuthRequired, AuthMethods: methods}, nil
		}
		// A caller-selected method is a scoped setup operation. Preserve its
		// provider error while keeping the setup surface actionable; this does
		// not classify the error as provider-global authentication evidence.
		if methodID != "" && !errors.Is(err, ErrACPAuthMethodUnavailable) {
			return StandardACPSetupResult{Status: StandardACPSetupAuthRequired, AuthMethods: methods}, err
		}
		// Some ACP agents advertise both a provider credential method and a
		// terminal setup method. Before setup is completed, session/new may
		// synchronously initialize the provider and exceed the probe timeout.
		// Keep the install successful and expose the terminal setup action;
		// explicit authenticate/setup attempts still return their real error.
		if methodID == "" && standardACPSetupSessionNewTimedOut(err) && standardACPSetupHasInteractiveAuth(methods) {
			return StandardACPSetupResult{Status: StandardACPSetupAuthRequired, AuthMethods: methods}, nil
		}
		// This compatibility check is deliberately exact and scoped to the setup
		// probe. Some ACP agents use the generic -32000 JSON-RPC code with the
		// literal value below after advertising authentication methods. Do not
		// teach acpCallError.AuthRequired to infer from prose: ordinary Turns must
		// keep generic JSON-RPC failures provider-scoped, and unrelated setup
		// failures (for example overloaded relays) must remain visible.
		if methodID == "" && standardACPSetupSessionNewAuthRejected(err) && len(methods) > 0 {
			return StandardACPSetupResult{Status: StandardACPSetupAuthRequired, AuthMethods: methods}, nil
		}
		if IsAuthenticationRequired(err) || standardACPSetupNeedsConfiguration(err, methods) {
			if methodID != "" {
				return StandardACPSetupResult{Status: StandardACPSetupAuthRequired, AuthMethods: methods}, err
			}
			return StandardACPSetupResult{Status: StandardACPSetupAuthRequired, AuthMethods: methods}, nil
		}
		return StandardACPSetupResult{}, err
	}
	closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := adapter.Close(closeCtx, session); err != nil {
		return StandardACPSetupResult{}, fmt.Errorf("close ACP setup session: %w", err)
	}
	return StandardACPSetupResult{Status: StandardACPSetupReady, AuthMethods: methods, Account: account}, nil
}

func standardACPSetupSessionNewAuthRejected(err error) bool {
	var callErr *acpCallError
	return errors.As(err, &callErr) &&
		callErr.Method == acpMethodNewSession &&
		strings.EqualFold(strings.TrimSpace(callErr.Err.Message), "authentication required")
}

func standardACPSetupHasInteractiveAuth(methods []StandardACPAuthMethod) bool {
	for _, method := range methods {
		if strings.TrimSpace(method.Type) == "terminal" {
			return true
		}
	}
	return false
}

func standardACPSetupSessionNewTimedOut(err error) bool {
	return err != nil && errors.Is(err, context.DeadlineExceeded) &&
		strings.Contains(strings.ToLower(err.Error()), "session/new")
}

func standardACPSetupNeedsConfiguration(err error, methods []StandardACPAuthMethod) bool {
	if err == nil || !standardACPUnconfiguredProviderPattern.MatchString(err.Error()) {
		return false
	}
	for _, method := range methods {
		if method.Type == "terminal" && len(method.Args) > 0 {
			return true
		}
	}
	return false
}

func parseStandardACPAuthenticatedAccount(result json.RawMessage, methodID string) *StandardACPAuthenticatedAccount {
	var payload struct {
		Meta map[string]json.RawMessage `json:"_meta"`
	}
	if json.Unmarshal(result, &payload) != nil || len(payload.Meta) == 0 {
		return nil
	}
	keys := make([]string, 0, len(payload.Meta))
	for key := range payload.Meta {
		if strings.HasSuffix(strings.ToLower(strings.TrimSpace(key)), "/userinfo") {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		var candidate struct {
			UserID         string `json:"userId"`
			UserName       string `json:"userName"`
			UserNickname   string `json:"userNickname"`
			Enterprise     string `json:"enterprise"`
			EnterpriseName string `json:"enterpriseName"`
		}
		if json.Unmarshal(payload.Meta[key], &candidate) != nil {
			continue
		}
		id := normalizeStandardACPAccountField(candidate.UserID)
		displayName := normalizeStandardACPAccountField(candidate.UserNickname)
		if displayName == "" {
			displayName = normalizeStandardACPAccountField(candidate.UserName)
		}
		if id == "" {
			id = displayName
		}
		if displayName == "" {
			displayName = id
		}
		if id == "" || displayName == "" {
			continue
		}
		organization := normalizeStandardACPAccountField(candidate.EnterpriseName)
		if organization == "" {
			organization = normalizeStandardACPAccountField(candidate.Enterprise)
		}
		return &StandardACPAuthenticatedAccount{
			ID: id, DisplayName: displayName, AuthMethodID: methodID, Organization: organization,
		}
	}
	return nil
}

func normalizeStandardACPAccountField(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || utf8.RuneCountInString(value) > 256 {
		return ""
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return ""
		}
	}
	return value
}

func parseStandardACPAuthMethods(initializeResult json.RawMessage) []StandardACPAuthMethod {
	var payload struct {
		AuthMethods []struct {
			ID          string                     `json:"id"`
			Name        string                     `json:"name"`
			Description string                     `json:"description"`
			Type        string                     `json:"type"`
			Args        []string                   `json:"args"`
			Meta        map[string]json.RawMessage `json:"_meta"`
		} `json:"authMethods"`
	}
	if json.Unmarshal(initializeResult, &payload) != nil {
		return nil
	}
	result := make([]StandardACPAuthMethod, 0, len(payload.AuthMethods))
	seen := map[string]struct{}{}
	for _, method := range payload.AuthMethods {
		id := strings.TrimSpace(method.ID)
		name := strings.TrimSpace(method.Name)
		if id == "" || name == "" || len(id) > 128 || len(name) > 256 {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		methodType := normalizeStandardACPAuthMethodType(method.Type)
		methodArgs := normalizeStandardACPAuthMethodArgs(method.Args)
		if methodType == "" || len(methodArgs) == 0 {
			metaType, metaArgs := parseStandardACPTerminalAuthMeta(method.Meta)
			if methodType == "" {
				methodType = metaType
			}
			if len(methodArgs) == 0 {
				methodArgs = metaArgs
			}
		}
		result = append(result, StandardACPAuthMethod{
			ID: id, Name: name, Description: strings.TrimSpace(method.Description),
			Type: methodType, Args: methodArgs,
		})
		if len(result) == 32 {
			break
		}
	}
	return result
}

// parseStandardACPTerminalAuthMeta extracts the terminal-type method kind and
// CLI arguments from the provider's `_meta["terminal-auth"]` extension (the
// shape Kimi Code declares in its initialize response, where the method type
// does not appear as a top-level field).
func parseStandardACPTerminalAuthMeta(meta map[string]json.RawMessage) (string, []string) {
	if len(meta) == 0 {
		return "", nil
	}
	raw, ok := meta["terminal-auth"]
	if !ok {
		return "", nil
	}
	var terminalAuth struct {
		Type string   `json:"type"`
		Args []string `json:"args"`
	}
	if json.Unmarshal(raw, &terminalAuth) != nil {
		return "", nil
	}
	return normalizeStandardACPAuthMethodType(terminalAuth.Type),
		normalizeStandardACPAuthMethodArgs(terminalAuth.Args)
}

func normalizeStandardACPAuthMethodType(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > 64 {
		return ""
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return ""
		}
	}
	return value
}

func normalizeStandardACPAuthMethodArgs(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	args := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || utf8.RuneCountInString(trimmed) > 256 {
			return nil
		}
		args = append(args, trimmed)
		if len(args) == 16 {
			break
		}
	}
	return args
}

func findStandardACPAuthMethod(methods []StandardACPAuthMethod, methodID string) *StandardACPAuthMethod {
	for index := range methods {
		if methods[index].ID == methodID {
			return &methods[index]
		}
	}
	return nil
}

// acpSessionHasNoUsableModel reports whether the session/new response carries
// a model selector that advertises zero available models and no current model.
// ACP agents expose that state either through the legacy top-level `models`
// object or through a model `configOptions` selector. A missing model selector
// (providers that do not declare one) and a populated selector both pass.
func acpSessionHasNoUsableModel(raw json.RawMessage) bool {
	var payload struct {
		Models *struct {
			AvailableModels *[]json.RawMessage `json:"availableModels"`
			CurrentModelID  string             `json:"currentModelId"`
		} `json:"models"`
		ConfigOptions []struct {
			ID           string             `json:"id"`
			Category     string             `json:"category"`
			CurrentValue json.RawMessage    `json:"currentValue"`
			Options      *[]json.RawMessage `json:"options"`
		} `json:"configOptions"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return false
	}
	if payload.Models != nil &&
		payload.Models.AvailableModels != nil &&
		len(*payload.Models.AvailableModels) == 0 &&
		strings.TrimSpace(payload.Models.CurrentModelID) == "" {
		return true
	}
	for _, option := range payload.ConfigOptions {
		isModelSelector :=
			strings.EqualFold(strings.TrimSpace(option.ID), "model") ||
				strings.EqualFold(strings.TrimSpace(option.Category), "model")
		if !isModelSelector || option.Options == nil || len(*option.Options) != 0 {
			continue
		}
		var currentValue string
		if len(option.CurrentValue) == 0 ||
			string(option.CurrentValue) == "null" ||
			(json.Unmarshal(option.CurrentValue, &currentValue) == nil &&
				strings.TrimSpace(currentValue) == "") {
			return true
		}
	}
	return false
}
