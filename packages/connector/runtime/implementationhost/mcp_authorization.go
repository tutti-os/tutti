package implementationhost

import (
	"errors"
	"net/http"

	market "github.com/tutti-os/tutti/packages/connector/daemon/core"
	"github.com/tutti-os/tutti/packages/connector/runtime/mcp"
)

const (
	mcpAuthorizationRequiredCode = -33001
	mcpAuthorizationExpiredCode  = -33002
)

func wrapRemoteMCPAuthorizationError(err error) error {
	if err == nil {
		return nil
	}
	var domain *market.DomainError
	if errors.As(err, &domain) && domain.Code == market.ErrorCodeAuthorizationFailed {
		return err
	}
	if !remoteMCPAuthorizationRequired(err) {
		return err
	}
	return market.NewDomainError(
		market.ErrorCodeAuthorizationFailed,
		"connector authorization is required",
		false,
		err,
	)
}

func remoteMCPAuthorizationRequired(err error) bool {
	var rpcErr *mcp.RPCError
	if errors.As(err, &rpcErr) &&
		(rpcErr.Code == mcpAuthorizationRequiredCode || rpcErr.Code == mcpAuthorizationExpiredCode) {
		return true
	}
	var httpErr *mcp.ModernHTTPError
	return errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusPreconditionRequired
}
