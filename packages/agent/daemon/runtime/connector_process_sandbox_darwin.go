//go:build darwin

package agentruntime

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const connectorSandboxExecutable = "/usr/bin/sandbox-exec"

type darwinConnectorProcessSandbox struct{}

func platformConnectorProcessSandbox() connectorProcessSandbox {
	info, err := os.Stat(connectorSandboxExecutable)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		return nil
	}
	return darwinConnectorProcessSandbox{}
}

func (darwinConnectorProcessSandbox) Apply(command *exec.Cmd, spec ProcessSpec) error {
	if command == nil || spec.ConnectorSandbox == nil || !filepath.IsAbs(command.Path) {
		return errors.New("darwin connector sandbox input is invalid")
	}
	profile, err := darwinConnectorSandboxProfile(*spec.ConnectorSandbox, command.Path)
	if err != nil {
		return err
	}
	originalPath := command.Path
	originalArgs := append([]string(nil), command.Args[1:]...)
	command.Path = connectorSandboxExecutable
	command.Args = append([]string{connectorSandboxExecutable, "-p", profile, originalPath}, originalArgs...)
	return nil
}

func darwinConnectorSandboxProfile(policy ConnectorSandboxPolicy, executable string) (string, error) {
	secondaryExecutables, err := normalizedSandboxExecutablePaths(policy.AllowedExecutables)
	if err != nil {
		return "", err
	}
	readPaths, err := normalizedSandboxPaths(append(append([]string{executable}, secondaryExecutables...), policy.ReadOnlyPaths...))
	if err != nil {
		return "", err
	}
	writePaths, err := normalizedSandboxPaths(policy.WritablePaths)
	if err != nil {
		return "", err
	}
	var profile strings.Builder
	profile.WriteString("(version 1)\n(deny default)\n")
	// The verified runtime is the only executable admitted by the profile.
	// Interpreted connector code may fork runtime workers, but it cannot exec a
	// downloaded helper or discover arbitrary user Mach/XPC services.
	profile.WriteString("(allow process-fork)\n")
	for _, allowed := range append([]string{filepath.Clean(executable)}, secondaryExecutables...) {
		profile.WriteString("(allow process-exec (literal " + strconv.Quote(allowed) + "))\n")
	}
	profile.WriteString("(allow signal (target self))\n(allow sysctl-read)\n")
	// dyld probes the root directory before resolving the pinned executable.
	// literal "/" admits only that directory entry read, not descendant data.
	profile.WriteString("(allow file-read-data file-read-metadata (literal \"/\"))\n")
	// macOS name resolution probes the /var symlink before reaching resolver
	// state under /private/var. Admit only the link metadata; descendants remain
	// governed by the explicit fixed/read/write paths below.
	profile.WriteString("(allow file-read-metadata (literal \"/var\"))\n")
	fixedPaths := []string{"/System", "/usr/lib", "/usr/share", "/Library/Apple", "/private/etc/ssl", "/etc/ssl", "/private/var/db/timezone", "/dev/null", "/dev/random", "/dev/urandom"}
	metadataPaths := append(append([]string{}, fixedPaths...), readPaths...)
	metadataPaths = append(metadataPaths, writePaths...)
	for _, ancestor := range sandboxPathAncestors(metadataPaths) {
		profile.WriteString("(allow file-read-metadata (literal " + strconv.Quote(ancestor) + "))\n")
	}
	for _, fixed := range fixedPaths {
		profile.WriteString("(allow file-read* (subpath " + strconv.Quote(fixed) + "))\n")
	}
	// Child-process stdio set to "ignore" is implemented by opening /dev/null
	// for writing. The null device discards the bytes and does not expand the
	// sandbox's access to persistent files.
	profile.WriteString("(allow file-write* (literal \"/dev/null\"))\n")
	for _, allowed := range secondaryExecutables {
		// Reading the explicitly admitted pathname is required before exec when
		// the PATH-selected command is itself a symlink (for example tar).
		profile.WriteString("(allow file-read* (literal " + strconv.Quote(allowed) + "))\n")
	}
	for _, path := range readPaths {
		profile.WriteString("(allow file-read* (subpath " + strconv.Quote(path) + "))\n")
	}
	for _, path := range writePaths {
		profile.WriteString("(allow file-read* file-write* (subpath " + strconv.Quote(path) + "))\n")
	}
	if policy.Network {
		profile.WriteString("(allow network*)\n")
	}
	return profile.String(), nil
}

func normalizedSandboxExecutablePaths(values []string) ([]string, error) {
	result := make([]string, 0, len(values)*2)
	seen := map[string]struct{}{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || !filepath.IsAbs(value) || strings.ContainsRune(value, '\x00') {
			return nil, fmt.Errorf("connector sandbox path %q is invalid", value)
		}
		cleaned := filepath.Clean(value)
		resolved, err := filepath.EvalSymlinks(cleaned)
		if err != nil {
			return nil, fmt.Errorf("resolve connector sandbox path %q: %w", value, err)
		}
		// posix_spawn may authorize the PATH-selected symlink before the kernel
		// resolves its target. Pin both names to the same explicitly admitted
		// executable instead of granting process-exec to their parent directory.
		for _, candidate := range []string{cleaned, filepath.Clean(resolved)} {
			if _, exists := seen[candidate]; exists {
				continue
			}
			seen[candidate] = struct{}{}
			result = append(result, candidate)
		}
	}
	return result, nil
}

func sandboxPathAncestors(paths []string) []string {
	seen := map[string]struct{}{}
	for _, path := range paths {
		for parent := filepath.Dir(filepath.Clean(path)); parent != "." && parent != string(filepath.Separator); parent = filepath.Dir(parent) {
			seen[parent] = struct{}{}
		}
	}
	result := make([]string, 0, len(seen))
	for path := range seen {
		result = append(result, path)
	}
	sort.Strings(result)
	return result
}

func normalizedSandboxPaths(values []string) ([]string, error) {
	result := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || !filepath.IsAbs(value) || strings.ContainsRune(value, '\x00') {
			return nil, fmt.Errorf("connector sandbox path %q is invalid", value)
		}
		cleaned := filepath.Clean(value)
		resolved, err := filepath.EvalSymlinks(cleaned)
		if err != nil {
			return nil, fmt.Errorf("resolve connector sandbox path %q: %w", value, err)
		}
		cleaned = filepath.Clean(resolved)
		if _, exists := seen[cleaned]; exists {
			continue
		}
		seen[cleaned] = struct{}{}
		result = append(result, cleaned)
	}
	return result, nil
}
