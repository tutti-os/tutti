package implementationhost

import (
	"errors"
	"fmt"
	"strings"
)

type credentialBrokerReportedError struct {
	operation string
	code      string
	message   string
}

func (failure *credentialBrokerReportedError) Error() string {
	if failure.code != "" {
		return fmt.Sprintf("%s connector authorization (%s): %s", failure.operation, failure.code, failure.message)
	}
	return fmt.Sprintf("%s connector authorization: %s", failure.operation, failure.message)
}

func credentialBrokerEventError(event credentialBrokerEvent, operation string) error {
	message := boundedBrokerMessage(event.Message)
	if message == "" {
		message = "connector credential broker reported an error"
	}
	return &credentialBrokerReportedError{
		operation: operation,
		code:      normalizeCredentialBrokerFailureCode(event.Code),
		message:   message,
	}
}

func credentialBrokerFailureCode(err error) string {
	var reported *credentialBrokerReportedError
	if errors.As(err, &reported) && reported.code != "" {
		return reported.code
	}
	return "credential_broker_failed"
}

func normalizeCredentialBrokerFailureCode(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 {
		return ""
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if character >= 'a' && character <= 'z' ||
			index > 0 && character >= '0' && character <= '9' ||
			index > 0 && (character == '_' || character == '-' || character == '.') {
			continue
		}
		return ""
	}
	return value
}
