package implementationhost

import (
	"errors"
	"net/http"
	"testing"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	"github.com/tutti-os/tutti/packages/connector/runtime/mcp"
)

func TestWrapRemoteMCPAuthorizationErrorMapsPreconditionRequired(t *testing.T) {
	cause := &mcp.ModernHTTPError{
		StatusCode: http.StatusPreconditionRequired,
		Cause:      &mcp.RPCError{Code: -33001, Message: "authorization required"},
	}
	err := wrapRemoteMCPAuthorizationError(cause)
	var domain *market.DomainError
	if !errors.As(err, &domain) || domain.Code != market.ErrorCodeAuthorizationFailed || domain.Retryable {
		t.Fatalf("error = %#v", err)
	}
}

func TestWrapRemoteMCPAuthorizationErrorLeavesTransientFailures(t *testing.T) {
	cause := &mcp.ModernHTTPError{StatusCode: http.StatusBadGateway}
	err := wrapRemoteMCPAuthorizationError(cause)
	var domain *market.DomainError
	if err != cause || errors.As(err, &domain) {
		t.Fatalf("error = %#v", err)
	}
}
