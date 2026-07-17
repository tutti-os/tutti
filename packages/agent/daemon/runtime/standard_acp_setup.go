package agentruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var ErrACPAuthMethodUnavailable = errors.New("ACP authentication method is unavailable")

type StandardACPSetupStatus string

const (
	StandardACPSetupReady        StandardACPSetupStatus = "ready"
	StandardACPSetupAuthRequired StandardACPSetupStatus = "auth_required"
)

type StandardACPAuthMethod struct {
	ID          string
	Name        string
	Description string
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
	adapterValue, err := NewStandardACPAdapter(config, transport, host)
	if err != nil {
		return StandardACPSetupResult{}, err
	}
	adapter := adapterValue.(*standardACPAdapter)
	methodID = strings.TrimSpace(methodID)
	var methods []StandardACPAuthMethod
	var account *StandardACPAuthenticatedAccount
	adapter.config.beforeNewSession = func(ctx context.Context, client *acpClient, session Session, initializeResult json.RawMessage) error {
		methods = parseStandardACPAuthMethods(initializeResult)
		if methodID == "" {
			return nil
		}
		if !containsStandardACPAuthMethod(methods, methodID) {
			return fmt.Errorf("%w: %s", ErrACPAuthMethodUnavailable, methodID)
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
		if IsAuthenticationRequired(err) {
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
			ID          string `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
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
		result = append(result, StandardACPAuthMethod{
			ID: id, Name: name, Description: strings.TrimSpace(method.Description),
		})
		if len(result) == 32 {
			break
		}
	}
	return result
}

func containsStandardACPAuthMethod(methods []StandardACPAuthMethod, methodID string) bool {
	for _, method := range methods {
		if method.ID == methodID {
			return true
		}
	}
	return false
}
