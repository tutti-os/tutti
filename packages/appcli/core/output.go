package core

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

func DecodeCommandOutput(content []byte) (CommandOutput, error) {
	var raw struct {
		Kind         OutputMode       `json:"kind"`
		Columns      []TableColumn    `json:"columns"`
		Rows         []map[string]any `json:"rows"`
		Value        map[string]any   `json:"value"`
		Text         string           `json:"text"`
		Continuation *struct {
			State        CommandContinuationState `json:"state"`
			RetryAfterMs int                      `json:"retryAfterMs"`
		} `json:"continuation"`
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	if err := decoder.Decode(&raw); err != nil {
		return CommandOutput{}, err
	}
	if raw.Kind == "" {
		return CommandOutput{}, errors.New("cli command output kind is required")
	}
	output := CommandOutput{
		Kind:    raw.Kind,
		Columns: raw.Columns,
		Rows:    raw.Rows,
		Value:   raw.Value,
		Text:    raw.Text,
	}
	if raw.Continuation != nil {
		output.Continuation = &CommandContinuation{
			State: raw.Continuation.State, RetryAfterMs: raw.Continuation.RetryAfterMs,
		}
	}
	return output, nil
}

func ValidateCommandOutput(contract CapabilityOutput, output CommandOutput) (CommandOutput, error) {
	switch output.Kind {
	case OutputModeJSON:
		if !contract.JSON {
			return CommandOutput{}, invokeError(ErrHandlerBadResponse, "app_cli_handler_bad_response", errors.New("json output is not declared"))
		}
	case OutputModeTable:
		if contract.Table == nil {
			return CommandOutput{}, invokeError(ErrHandlerBadResponse, "app_cli_handler_bad_response", errors.New("table output is not declared"))
		}
		columns, err := normalizeOutputColumns(contract.Table.Columns, output.Columns)
		if err != nil {
			return CommandOutput{}, invokeError(ErrHandlerBadResponse, "app_cli_handler_bad_response", err)
		}
		output.Columns = columns
	default:
		return CommandOutput{}, invokeError(ErrHandlerBadResponse, "app_cli_handler_bad_response", fmt.Errorf("unsupported output kind %q", output.Kind))
	}
	return output, nil
}

func ValidateCommandContinuation(execution *CommandExecution, output CommandOutput) error {
	continuation := output.Continuation
	if continuation == nil {
		return nil
	}
	if execution == nil || execution.Mode != CommandExecutionModeWait {
		return invokeError(ErrHandlerBadResponse, "app_cli_handler_bad_response", errors.New("continuation is only allowed for wait commands"))
	}
	if output.Kind != OutputModeJSON {
		return invokeError(ErrHandlerBadResponse, "app_cli_handler_bad_response", errors.New("wait continuation requires json output"))
	}
	if continuation.State != CommandContinuationStatePending {
		return invokeError(ErrHandlerBadResponse, "app_cli_handler_bad_response", fmt.Errorf("unsupported continuation state %q", continuation.State))
	}
	if continuation.RetryAfterMs < MinContinuationRetryAfterMs || continuation.RetryAfterMs > MaxContinuationRetryAfterMs {
		return invokeError(
			ErrHandlerBadResponse,
			"app_cli_handler_bad_response",
			fmt.Errorf("continuation retryAfterMs must be between %d and %d", MinContinuationRetryAfterMs, MaxContinuationRetryAfterMs),
		)
	}
	return nil
}

func normalizeOutputColumns(contract []TableColumn, actual []TableColumn) ([]TableColumn, error) {
	if len(actual) == 0 {
		return append([]TableColumn(nil), contract...), nil
	}
	contractByKey := map[string]TableColumn{}
	for _, column := range contract {
		contractByKey[column.Key] = column
	}
	result := make([]TableColumn, 0, len(actual))
	for _, column := range actual {
		expected, ok := contractByKey[column.Key]
		if !ok || expected.Label != column.Label {
			return nil, fmt.Errorf("table output column %q is not declared", column.Key)
		}
		result = append(result, column)
	}
	return result, nil
}
