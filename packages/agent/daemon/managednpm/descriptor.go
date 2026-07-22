// Package managednpm defines the reusable policy for provider runtimes that
// are distributed as npm packages. Hosts retain ownership of command
// execution, filesystem paths, credentials, and VM transport.
package managednpm

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	packageNamePattern = regexp.MustCompile(`^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`)
	binaryNamePattern  = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
)

// Descriptor is data, not an executable install plan. In particular it does
// not accept shell commands, arbitrary environment variables, or paths.
type Descriptor struct {
	PackageName        string
	BinaryName         string
	MinimumVersion     string
	RecommendedVersion string
	IncludeOptional    bool
}

func (d Descriptor) Validate() error {
	if d.PackageName != strings.TrimSpace(d.PackageName) || !packageNamePattern.MatchString(d.PackageName) {
		return fmt.Errorf("managed npm package name is invalid")
	}
	if d.BinaryName != strings.TrimSpace(d.BinaryName) || !binaryNamePattern.MatchString(d.BinaryName) {
		return fmt.Errorf("managed npm binary name is invalid")
	}
	minimum, ok := parseStableVersion(d.MinimumVersion)
	if !ok {
		return fmt.Errorf("managed npm minimum version must be a stable x.y.z version")
	}
	recommended, ok := parseStableVersion(d.RecommendedVersion)
	if !ok {
		return fmt.Errorf("managed npm recommended version must be a stable x.y.z version")
	}
	if compareVersions(recommended, minimum) < 0 {
		return fmt.Errorf("managed npm recommended version is below the minimum version")
	}
	return nil
}
