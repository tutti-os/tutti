package app

import (
	"fmt"
	"io"
	"strings"

	"github.com/tutti-os/tutti/apps/cli/internal/daemon"
)

const (
	reasonCommandNotFound      = "command_not_found"
	reasonCommandOutputMissing = "command_output_missing"
	reasonDaemonRequestFailed  = "daemon_request_failed"
	reasonDaemonUnavailable    = "daemon_unavailable"
	reasonInvalidInput         = "invalid_input"
)

type cliErrorEnvelope struct {
	Error cliErrorDetails `json:"error"`
}

type cliErrorDetails struct {
	ReasonCode    string `json:"reasonCode"`
	Message       string `json:"message"`
	Retryable     bool   `json:"retryable,omitempty"`
	CorrelationID string `json:"correlationId,omitempty"`
}

func jsonRequested(args []string) bool {
	for _, arg := range args {
		if arg == "--json" {
			return true
		}
	}
	return false
}

func writeCLIError(
	stdout io.Writer,
	stderr io.Writer,
	jsonOutput bool,
	prefix string,
	reasonCode string,
	err error,
	exitCode int,
) int {
	message := strings.TrimSpace(errorMessage(err))
	if jsonOutput {
		details := cliErrorDetails{
			ReasonCode: strings.TrimSpace(reasonCode),
			Message:    message,
		}
		if daemonDetails, ok := daemon.RequestErrorDetails(err); ok {
			if daemonDetails.ReasonCode != "" {
				details.ReasonCode = daemonDetails.ReasonCode
			}
			if daemonDetails.Message != "" {
				details.Message = daemonDetails.Message
			}
			details.Retryable = daemonDetails.Retryable
			details.CorrelationID = daemonDetails.CorrelationID
		}
		if details.ReasonCode == "" {
			details.ReasonCode = reasonInvalidInput
		}
		if details.Message == "" {
			details.Message = details.ReasonCode
		}
		if code := writeJSON(stdout, stderr, cliErrorEnvelope{Error: details}); code != 0 {
			return code
		}
		return exitCode
	}
	if prefix == "" {
		fmt.Fprintln(stderr, message)
	} else {
		fmt.Fprintf(stderr, "%s: %s\n", strings.TrimSpace(prefix), message)
	}
	return exitCode
}

func daemonErrorExitCode(err error) int {
	details, ok := daemon.RequestErrorDetails(err)
	if ok && details.StatusCode == 400 {
		return 2
	}
	return 1
}

func errorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
