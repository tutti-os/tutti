package agentextension

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (m *Manager) localAccountUsageExecutable(installation Installation) string {
	if m == nil || !installation.HasLocalPackageProvenance() {
		return ""
	}
	for _, source := range m.Sources {
		if source.Key == installation.AgentKey && sourceUsesLocalPackage(source) {
			return strings.TrimSpace(source.LocalAccountUsageExecutable)
		}
	}
	return ""
}

func resolvedLocalAccountUsageRuntimeBinding(
	executable string,
	profile *AccountUsageProfile,
) (*AccountUsageRuntimeBinding, error) {
	executable = strings.TrimSpace(executable)
	if executable == "" || !filepath.IsAbs(executable) || profile == nil {
		return nil, errors.New("local account usage companion is invalid")
	}
	info, err := os.Lstat(executable)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !isExecutableFileInfo(info) {
		return nil, errors.New("local account usage companion is not an ordinary executable")
	}
	realExecutable, err := filepath.EvalSymlinks(executable)
	if err != nil || filepath.Clean(realExecutable) != filepath.Clean(executable) {
		return nil, errors.New("local account usage companion path is invalid")
	}
	fingerprint, err := fingerprintRuntimeExecutable(realExecutable)
	if err != nil {
		return nil, fmt.Errorf("fingerprint local account usage companion: %w", err)
	}
	if err := verifyRuntimeExecutableUnchanged(realExecutable, fingerprint); err != nil {
		return nil, err
	}
	return &AccountUsageRuntimeBinding{
		Command:            append([]string{realExecutable}, profile.Runtime.Args...),
		Timeout:            time.Duration(profile.Runtime.TimeoutMS) * time.Millisecond,
		ExecutableIdentity: executableIdentity(fingerprint),
	}, nil
}

func stagedAccountUsageActivation(
	plan InstallPlan,
	staging string,
	realStaging string,
) (*managedRuntimeCompanionActivation, error) {
	if plan.AccountUsage == nil {
		return nil, nil
	}
	stagedExecutable, err := stagedRuntimePath(
		plan.InstallRoot,
		plan.AccountUsage.Executable,
		staging,
	)
	if err != nil {
		return nil, fmt.Errorf("resolve account usage companion: %w", err)
	}
	realExecutable, err := filepath.EvalSymlinks(stagedExecutable)
	if err != nil {
		return nil, fmt.Errorf("resolve account usage companion executable: %w", err)
	}
	if !pathWithin(realExecutable, realStaging) {
		return nil, errors.New("account usage companion executable escapes staging root")
	}
	info, err := os.Lstat(realExecutable)
	if err != nil || !isExecutableFileInfo(info) || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("account usage companion executable is not an ordinary file")
	}
	fingerprint, err := fingerprintRuntimeExecutable(realExecutable)
	if err != nil {
		return nil, fmt.Errorf("fingerprint account usage companion executable: %w", err)
	}
	if err := verifyRuntimeExecutableUnchanged(realExecutable, fingerprint); err != nil {
		return nil, err
	}
	relativeExecutable, err := filepath.Rel(realStaging, realExecutable)
	if err != nil || relativeExecutable == "." || !pathWithin(realExecutable, realStaging) {
		return nil, errors.New("account usage companion executable path is invalid")
	}
	return &managedRuntimeCompanionActivation{
		Package:                plan.AccountUsage.Package,
		ExecutableRelativePath: filepath.ToSlash(relativeExecutable),
		ExecutableFingerprint:  fingerprint,
	}, nil
}

func resolvedAccountUsageRuntimeBinding(
	active *managedRuntimeDirectory,
	root string,
	activation managedRuntimeActivation,
	profile *AccountUsageProfile,
) (*AccountUsageRuntimeBinding, error) {
	if profile == nil {
		if activation.AccountUsage != nil {
			return nil, fmt.Errorf("%w: unexpected account usage companion activation", ErrManagedRuntimeIntegrity)
		}
		return nil, nil
	}
	companion := activation.AccountUsage
	if companion == nil || companion.Package != profile.Runtime.Package {
		return nil, fmt.Errorf("%w: account usage companion activation identity is invalid", ErrManagedRuntimeIntegrity)
	}
	relativeExecutable := filepath.Clean(filepath.FromSlash(companion.ExecutableRelativePath))
	if relativeExecutable == "." || filepath.IsAbs(relativeExecutable) || relativeExecutable == ".." || !pathWithin(filepath.Join(root, relativeExecutable), root) {
		return nil, fmt.Errorf("%w: account usage companion executable escapes install root", ErrManagedRuntimeIntegrity)
	}
	declaredExecutable := filepath.Clean(resolveAccountUsageExecutable(profile.Runtime.Executable, root))
	realDeclaredExecutable, err := filepath.EvalSymlinks(declaredExecutable)
	if err != nil || filepath.Clean(realDeclaredExecutable) != filepath.Join(root, relativeExecutable) {
		return nil, fmt.Errorf("%w: account usage companion executable does not match the signed profile", ErrManagedRuntimeIntegrity)
	}
	executableFile, err := active.openFile(relativeExecutable, os.O_RDONLY)
	if err != nil {
		return nil, fmt.Errorf("%w: account usage companion executable is not an ordinary file", ErrManagedRuntimeIntegrity)
	}
	fingerprint, fingerprintErr := fingerprintRuntimeExecutableFile(executableFile)
	closeErr := executableFile.Close()
	if fingerprintErr != nil || closeErr != nil || fingerprint != companion.ExecutableFingerprint || fingerprint.SHA256 == "" {
		return nil, fmt.Errorf("%w: account usage companion executable fingerprint changed", ErrManagedRuntimeIntegrity)
	}
	return &AccountUsageRuntimeBinding{
		Command: append(
			[]string{filepath.Join(root, relativeExecutable)},
			profile.Runtime.Args...,
		),
		Timeout:            time.Duration(profile.Runtime.TimeoutMS) * time.Millisecond,
		ExecutableIdentity: executableIdentity(fingerprint),
	}, nil
}

func resolveAccountUsageExecutable(declaration, root string) string {
	return strings.NewReplacer("${installRoot}", root).Replace(declaration)
}

func stagedRuntimePath(installRoot, installedPath, staging string) (string, error) {
	relative, err := filepath.Rel(filepath.Clean(installRoot), filepath.Clean(installedPath))
	if err != nil || relative == "." || relative == ".." || !pathWithin(installedPath, installRoot) {
		return "", errors.New("runtime path escapes install root")
	}
	result := filepath.Join(staging, relative)
	if !pathWithin(result, staging) {
		return "", errors.New("staged runtime path escapes staging root")
	}
	return result, nil
}
