package host

import (
	"errors"
	"fmt"
)

var (
	ErrNotFound           = errors.New("connector market resource not found")
	ErrOperationLeaseLost = errors.New("connector market operation lease lost")
)

type ErrorCode string

const (
	ErrorCodeInvalidRequest            ErrorCode = "connector_market_invalid_request"
	ErrorCodeNotFound                  ErrorCode = "connector_not_found"
	ErrorCodeRevisionConflict          ErrorCode = "connector_market_revision_conflict"
	ErrorCodeOperationInProgress       ErrorCode = "connector_operation_in_progress"
	ErrorCodeIncompatible              ErrorCode = "connector_incompatible"
	ErrorCodeInvalidManifest           ErrorCode = "connector_manifest_invalid"
	ErrorCodeUnsupportedImplementation ErrorCode = "connector_implementation_unsupported"
	ErrorCodeUpstreamUnavailable       ErrorCode = "connector_market_upstream_unavailable"
	ErrorCodeInstallFailed             ErrorCode = "connector_install_failed"
	ErrorCodeAuthorizationFailed       ErrorCode = "connector_authorization_failed"
	ErrorCodeUnavailable               ErrorCode = "connector_market_unavailable"
)

type DomainError struct {
	Code      ErrorCode
	Message   string
	Retryable bool
	Cause     error
}

func (domainError *DomainError) Error() string {
	if domainError.Cause == nil {
		return domainError.Message
	}
	return fmt.Sprintf("%s: %v", domainError.Message, domainError.Cause)
}

func (domainError *DomainError) Unwrap() error {
	return domainError.Cause
}

func NewDomainError(code ErrorCode, message string, retryable bool, cause error) error {
	return &DomainError{
		Code:      code,
		Message:   message,
		Retryable: retryable,
		Cause:     cause,
	}
}

func preserveCatalogSourceError(message string, err error) error {
	var domainError *DomainError
	if errors.As(err, &domainError) {
		return err
	}
	return NewDomainError(ErrorCodeUpstreamUnavailable, message, true, err)
}

func errorCodeOr(err error, fallback ErrorCode) ErrorCode {
	var domainError *DomainError
	if errors.As(err, &domainError) {
		return domainError.Code
	}
	return fallback
}

func isRetryableError(err error) bool {
	var domainError *DomainError
	return errors.As(err, &domainError) && domainError.Retryable
}
