package host

import (
	"fmt"
	"regexp"
	"strings"
)

var executionTargetPattern = regexp.MustCompile(`^(darwin|linux|windows)-(arm64|amd64)$`)

// ExecutionTarget returns the canonical Connector target key for a Go runtime
// tuple. Connector manifests use Go's OS and architecture names deliberately,
// so target selection does not depend on npm, OCI, or vendor-specific aliases.
func ExecutionTarget(goos, goarch string) (string, error) {
	return NormalizeExecutionTarget(strings.TrimSpace(goos) + "-" + strings.TrimSpace(goarch))
}

// NormalizeExecutionTarget validates and canonicalizes an explicit target key.
func NormalizeExecutionTarget(target string) (string, error) {
	target = strings.ToLower(strings.TrimSpace(target))
	if !executionTargetPattern.MatchString(target) {
		return "", fmt.Errorf("connector execution target %q is unsupported", target)
	}
	return target, nil
}

// ResolveTargetImplementation selects one exact implementation. It never
// falls back across operating systems or architectures because runtime ABI and
// native launch checksums are target-specific security properties.
func ResolveTargetImplementation(target string, implementations map[string]Implementation) (Implementation, error) {
	var err error
	target, err = NormalizeExecutionTarget(target)
	if err != nil {
		return Implementation{}, err
	}
	implementation, ok := implementations[target]
	if !ok {
		return Implementation{}, fmt.Errorf("connector does not provide the %s execution target", target)
	}
	if implementation.ManagedStdio != nil && !strings.HasSuffix(strings.TrimSpace(implementation.ManagedStdio.Runtime.ABI), "-"+target) {
		return Implementation{}, fmt.Errorf("connector %s runtime ABI does not match its execution target", target)
	}
	return implementation, nil
}
