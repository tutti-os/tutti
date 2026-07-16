package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/tutti-os/tutti/apps/cli/internal/daemon"
)

const managedModelInputLimitBytes = 64 * 1024

const (
	managedModelExchangeCommandID   = "managed-model.grant.exchange"
	managedModelModelsCommandID     = "managed-model.models"
	managedModelCredentialCommandID = "managed-model.credential"
	managedModelRevokeCommandID     = "managed-model.revoke"
)

var managedModelInputReader = func() io.Reader { return os.Stdin }

type managedModelExchangeInput struct {
	ContextToken string `json:"contextToken"`
	GrantCode    string `json:"grantCode"`
	Nonce        string `json:"nonce"`
	State        string `json:"state"`
}

type managedModelGrantRefInput struct {
	GrantRef string `json:"grantRef"`
}

type managedModelCredentialInput struct {
	Capability  string `json:"capability"`
	GrantRef    string `json:"grantRef"`
	Model       string `json:"model"`
	ModelPlanID string `json:"modelPlanId"`
	Provider    string `json:"provider"`
}

func runManagedModel(ctx context.Context, commandName string, opts options, args []string, stdout io.Writer, stderr io.Writer) int {
	commandID, input, err := parseManagedModelInput(args)
	if err != nil {
		return writeCLIError(stdout, stderr, opts.json, commandName+" managed-model", reasonInvalidInput, err, 2)
	}
	client, err := discoverClient()
	if err != nil {
		return writeCLIError(stdout, stderr, opts.json, commandName+" managed-model", reasonDaemonUnavailable, err, 1)
	}
	response, err := client.Invoke(ctx, commandID, daemon.InvokeRequest{
		Input:      input,
		OutputMode: "json",
		Context:    cliInvokeContextFromEnv(),
	})
	if err != nil {
		return writeCLIError(stdout, stderr, opts.json, commandName+" managed-model", reasonDaemonRequestFailed, err, daemonErrorExitCode(err))
	}
	if response.Output == nil {
		return writeCLIError(
			stdout, stderr, opts.json, commandName+" managed-model", reasonCommandOutputMissing,
			fmt.Errorf("command returned no output"), 1,
		)
	}
	return writeDynamicJSON(stdout, stderr, *response.Output)
}

func parseManagedModelInput(args []string) (string, map[string]any, error) {
	commandID, payloadArgs, err := managedModelCommand(args)
	if err != nil {
		return "", nil, err
	}
	if len(payloadArgs) != 2 || payloadArgs[0] != "--input-json" || payloadArgs[1] != "-" {
		return "", nil, fmt.Errorf("usage: managed-model %s --input-json -", strings.Join(args[:len(args)-len(payloadArgs)], " "))
	}
	switch commandID {
	case managedModelExchangeCommandID:
		var input managedModelExchangeInput
		if err := decodeManagedModelInput(&input); err != nil {
			return "", nil, err
		}
		normalized, err := requiredManagedModelFields(map[string]any{
			"contextToken": input.ContextToken,
			"grantCode":    input.GrantCode,
			"nonce":        input.Nonce,
			"state":        input.State,
		})
		return commandID, normalized, err
	case managedModelModelsCommandID, managedModelRevokeCommandID:
		var input managedModelGrantRefInput
		if err := decodeManagedModelInput(&input); err != nil {
			return "", nil, err
		}
		normalized, err := requiredManagedModelFields(map[string]any{"grantRef": input.GrantRef})
		return commandID, normalized, err
	case managedModelCredentialCommandID:
		var input managedModelCredentialInput
		if err := decodeManagedModelInput(&input); err != nil {
			return "", nil, err
		}
		normalized, err := requiredManagedModelFields(map[string]any{
			"capability": input.Capability,
			"grantRef":   input.GrantRef,
			"model":      input.Model,
			"provider":   input.Provider,
		})
		if err == nil && strings.TrimSpace(input.ModelPlanID) != "" {
			normalized["modelPlanId"] = strings.TrimSpace(input.ModelPlanID)
		}
		return commandID, normalized, err
	default:
		return "", nil, fmt.Errorf("unsupported managed-model command")
	}
}

func managedModelCommand(args []string) (string, []string, error) {
	if len(args) >= 2 && args[0] == "grant" && args[1] == "exchange" {
		return managedModelExchangeCommandID, args[2:], nil
	}
	if len(args) >= 1 && args[0] == "models" {
		return managedModelModelsCommandID, args[1:], nil
	}
	if len(args) >= 1 && args[0] == "credential" {
		return managedModelCredentialCommandID, args[1:], nil
	}
	if len(args) >= 1 && args[0] == "revoke" {
		return managedModelRevokeCommandID, args[1:], nil
	}
	return "", nil, fmt.Errorf("expected grant exchange, models, credential, or revoke")
}

func decodeManagedModelInput(target any) error {
	reader := io.LimitReader(managedModelInputReader(), managedModelInputLimitBytes+1)
	content, err := io.ReadAll(reader)
	if err != nil {
		return fmt.Errorf("read input: %w", err)
	}
	if len(content) > managedModelInputLimitBytes {
		return fmt.Errorf("input exceeds %d bytes", managedModelInputLimitBytes)
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("invalid input JSON: %w", err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return fmt.Errorf("input must contain exactly one JSON object")
	}
	return nil
}

func requiredManagedModelFields(input map[string]any) (map[string]any, error) {
	for key, value := range input {
		text, ok := value.(string)
		if !ok || strings.TrimSpace(text) == "" {
			return nil, fmt.Errorf("%s is required", key)
		}
		input[key] = strings.TrimSpace(text)
	}
	return input, nil
}
