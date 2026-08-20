package providerregistry

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

func validateRemoteAuthProbe(descriptor RemoteAuthProbeDescriptor) error {
	if descriptor.Kind == "" {
		if descriptor.CredentialKind != "" || strings.TrimSpace(descriptor.Endpoint) != "" ||
			strings.TrimSpace(descriptor.Method) != "" || len(descriptor.Headers) > 0 ||
			descriptor.TimeoutSeconds != 0 {
			return fmt.Errorf("disabled descriptor must not declare probe settings")
		}
		return nil
	}
	if descriptor.TimeoutSeconds <= 0 {
		return fmt.Errorf("timeout seconds must be positive")
	}
	if descriptor.Kind == RemoteAuthProbeKindProviderUsage {
		if descriptor.CredentialKind != "" || strings.TrimSpace(descriptor.Endpoint) != "" ||
			strings.TrimSpace(descriptor.Method) != "" || len(descriptor.Headers) > 0 {
			return fmt.Errorf("provider usage probe must not declare HTTP settings")
		}
		return nil
	}
	if descriptor.Kind != RemoteAuthProbeKindHTTPBearer {
		return fmt.Errorf("kind %q is unsupported", descriptor.Kind)
	}
	switch descriptor.CredentialKind {
	case RemoteAuthCredentialKindClaudeOAuth:
	default:
		return fmt.Errorf("credential kind %q is unsupported", descriptor.CredentialKind)
	}
	endpoint, err := url.Parse(strings.TrimSpace(descriptor.Endpoint))
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" {
		return fmt.Errorf("endpoint must be an absolute HTTPS URL")
	}
	if method := strings.ToUpper(strings.TrimSpace(descriptor.Method)); method != http.MethodGet {
		return fmt.Errorf("method %q is unsupported", descriptor.Method)
	}
	for key, value := range descriptor.Headers {
		if strings.TrimSpace(key) == "" || strings.TrimSpace(value) == "" {
			return fmt.Errorf("headers must have non-empty names and values")
		}
		if strings.EqualFold(strings.TrimSpace(key), "Authorization") {
			return fmt.Errorf("authorization header is adapter-owned")
		}
	}
	return nil
}
