package agentstatus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const providerUpdateCheckTimeout = 5 * time.Second
const providerUpdateMetadataLimit = 1024 * 1024

func baseProviderUpdateStatus(spec ProviderSpec, currentVersion string, binaryPath string) UpdateStatus {
	status := UpdateStatus{
		Capability:        spec.Update.Capability,
		Source:            spec.Update.Source,
		CurrentVersion:    strings.TrimSpace(currentVersion),
		UnsupportedReason: strings.TrimSpace(spec.Update.UnsupportedReason),
	}
	if status.Capability == UpdateCapabilitySupported && strings.TrimSpace(binaryPath) != "" &&
		!providerRuntimeUsesManagedNPM(binaryPath, spec.Update.PackageName) {
		status.Capability = UpdateCapabilityUnsupported
		status.Source = ""
		status.UnsupportedReason = "unmanaged_install_source"
	}
	return status
}

func appendProviderAction(actions []Action, candidate Action) []Action {
	for _, action := range actions {
		if action.ID == candidate.ID {
			return actions
		}
	}
	return append(actions, candidate)
}

func (s Service) updateStatusForSpec(
	ctx context.Context,
	spec ProviderSpec,
	currentVersion string,
	binaryPath string,
	forceRefresh bool,
) UpdateStatus {
	status := baseProviderUpdateStatus(spec, currentVersion, binaryPath)
	if status.Capability != UpdateCapabilitySupported {
		return status
	}
	if status.CurrentVersion == "" {
		status.ReasonCode = "current_version_unavailable"
		return status
	}

	entry := s.cachedProviderUpdate(spec, ctx, forceRefresh)
	checkedAt := entry.checkedAt
	status.LastCheckedAt = &checkedAt
	status.LatestVersion = entry.latestVersion
	status.ReasonCode = entry.reasonCode
	if entry.reasonCode != "" || entry.latestVersion == "" {
		return status
	}
	comparison, ok := compareCLIVersions(status.CurrentVersion, entry.latestVersion)
	if !ok {
		status.ReasonCode = "version_comparison_unavailable"
		return status
	}
	available := comparison < 0
	status.UpdateAvailable = &available
	return status
}

func providerRuntimeUsesManagedNPM(binaryPath string, packageName string) bool {
	_, ok := managedNPMRepairInstallPrefix(binaryPath, packageName)
	return ok
}

func (s Service) cachedProviderUpdate(spec ProviderSpec, ctx context.Context, forceRefresh bool) providerUpdateCacheEntry {
	cache := s.UpdateCache
	if cache == nil {
		return s.discoverProviderUpdate(ctx, spec)
	}
	if !forceRefresh {
		if entry, ok := cache.get(spec.Provider, s.now(), s.providerUpdateCacheTTL()); ok {
			return entry
		}
	}

	value, _, _ := cache.group.Do(spec.Provider, func() (any, error) {
		if !forceRefresh {
			if entry, ok := cache.get(spec.Provider, s.now(), s.providerUpdateCacheTTL()); ok {
				return entry, nil
			}
		}
		entry := s.discoverProviderUpdate(ctx, spec)
		cache.set(spec.Provider, entry)
		return entry, nil
	})
	return value.(providerUpdateCacheEntry)
}

// DiscoverManagedProviderUpdates refreshes release metadata for installed,
// source-owned managed npm CLIs without touching readiness/status caches or
// executing an update action. Unsupported, missing, and unmanaged runtimes are
// local gates and never reach a registry.
func (s Service) DiscoverManagedProviderUpdates(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	specs, err := s.registry().Select(nil)
	if err != nil {
		return err
	}
	var discoveryErrors []error
	for _, spec := range specs {
		if spec.Update.Capability != UpdateCapabilitySupported ||
			spec.Update.Source != UpdateSourceNPM ||
			spec.Update.Strategy != ProviderUpdateStrategyManagedNPM {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		runtimeResolution := s.resolveProviderRuntime(ctx, spec)
		currentVersion := ""
		if strings.TrimSpace(runtimeResolution.CLIPath) != "" {
			currentVersion = s.providerCLIVersion(ctx, spec, runtimeResolution.CLIPath, runtimeResolution.Env)
		}
		status := baseProviderUpdateStatus(spec, currentVersion, runtimeResolution.CLIPath)
		if status.Capability != UpdateCapabilitySupported || status.CurrentVersion == "" {
			continue
		}
		entry := s.refreshProviderUpdate(ctx, spec)
		if entry.reasonCode != "" {
			discoveryErrors = append(discoveryErrors, fmt.Errorf("%s: %s", spec.Provider, entry.reasonCode))
		}
	}
	return errors.Join(discoveryErrors...)
}

func (s Service) refreshProviderUpdate(ctx context.Context, spec ProviderSpec) providerUpdateCacheEntry {
	cache := s.UpdateCache
	if cache == nil {
		return s.discoverProviderUpdate(ctx, spec)
	}
	value, _, _ := cache.group.Do(spec.Provider, func() (any, error) {
		entry := s.discoverProviderUpdate(ctx, spec)
		cache.set(spec.Provider, entry)
		return entry, nil
	})
	return value.(providerUpdateCacheEntry)
}

func (s Service) discoverProviderUpdate(ctx context.Context, spec ProviderSpec) providerUpdateCacheEntry {
	entry := providerUpdateCacheEntry{checkedAt: s.now()}
	if spec.Update.Source != UpdateSourceNPM || spec.Update.Strategy != ProviderUpdateStrategyManagedNPM {
		entry.reasonCode = "update_strategy_unsupported"
		return entry
	}
	latest, err := s.latestNPMVersion(ctx, spec.Update.PackageName)
	entry.checkedAt = s.now()
	if err != nil {
		entry.reasonCode = "update_check_failed"
		return entry
	}
	entry.latestVersion = latest
	return entry
}

func (s Service) providerUpdateCacheTTL() time.Duration {
	if s.UpdateCacheTTL != 0 {
		return s.UpdateCacheTTL
	}
	return defaultProviderUpdateCacheTTL
}

func (s Service) latestNPMVersion(ctx context.Context, packageName string) (string, error) {
	packageName = strings.TrimSpace(packageName)
	if packageName == "" {
		return "", errors.New("update npm package is empty")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	checkCtx, cancel := context.WithTimeout(ctx, providerUpdateCheckTimeout)
	defer cancel()

	type result struct {
		index   int
		version string
		err     error
	}
	registries := s.agentNPMRegistries()
	results := make(chan result, len(registries))
	for index, registry := range registries {
		go func(index int, registry string) {
			version, err := s.latestNPMVersionFromRegistry(checkCtx, registry, packageName)
			results <- result{index: index, version: version, err: err}
		}(index, registry)
	}

	byIndex := make([]result, len(registries))
	for range registries {
		value := <-results
		byIndex[value.index] = value
	}
	for _, value := range byIndex {
		if value.err == nil && strings.TrimSpace(value.version) != "" {
			return strings.TrimSpace(value.version), nil
		}
	}
	return "", fmt.Errorf("latest npm version unavailable for %s", packageName)
}

func (s Service) latestNPMVersionFromRegistry(ctx context.Context, registry string, packageName string) (string, error) {
	endpoint := npmRegistryPackageEndpoint(registry, packageName) + "/latest"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	response, err := s.httpClient().Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, providerUpdateMetadataLimit))
		return "", fmt.Errorf("npm registry returned %s", response.Status)
	}
	var metadata struct {
		Version string `json:"version"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, providerUpdateMetadataLimit))
	if err := decoder.Decode(&metadata); err != nil {
		return "", err
	}
	if strings.TrimSpace(metadata.Version) == "" {
		return "", errors.New("npm latest metadata omitted version")
	}
	return strings.TrimSpace(metadata.Version), nil
}

func (s Service) runUpdateAction(ctx context.Context, spec ProviderSpec, result RunActionResult) (RunActionResult, error) {
	if spec.Update.Capability != UpdateCapabilitySupported {
		result.Status = RunActionFailed
		result.ReasonCode = firstNonBlank(spec.Update.UnsupportedReason, "update_unsupported")
		result.Message = "Provider update is not supported for this installation source"
		return result, nil
	}
	if spec.Update.Source != UpdateSourceNPM || spec.Update.Strategy != ProviderUpdateStrategyManagedNPM {
		result.Status = RunActionFailed
		result.ReasonCode = "update_strategy_unsupported"
		result.Message = "Provider update strategy is not supported"
		return result, nil
	}

	updateCtx := withActiveActionToken(baseContext(ctx), nextActiveActionToken())
	claimActiveAction(updateCtx, spec.Provider, ActiveAction{ID: ActionUpdate, Status: "running", Step: "detect"})
	defer clearActiveAction(updateCtx, spec.Provider)

	runtimeResolution := s.resolveProviderRuntime(ctx, spec)
	if strings.TrimSpace(runtimeResolution.CLIPath) == "" {
		result.Status = RunActionFailed
		result.ReasonCode = "cli_not_found"
		result.Message = "Provider CLI must be installed before it can be updated"
		return result, nil
	}
	if !providerRuntimeUsesManagedNPM(runtimeResolution.CLIPath, spec.Update.PackageName) {
		result.Status = RunActionFailed
		result.ReasonCode = "unmanaged_install_source"
		result.Message = "Provider CLI installation source is not managed npm"
		return result, nil
	}
	currentVersion := s.providerCLIVersion(ctx, spec, runtimeResolution.CLIPath, runtimeResolution.Env)
	update := s.updateStatusForSpec(ctx, spec, currentVersion, runtimeResolution.CLIPath, true)
	if update.ReasonCode != "" {
		result.Status = RunActionFailed
		result.ReasonCode = update.ReasonCode
		result.Message = "Provider update discovery did not produce a comparable release"
		return result, nil
	}
	if update.UpdateAvailable == nil || !*update.UpdateAvailable {
		result.Status = RunActionCompleted
		result.ReasonCode = "already_up_to_date"
		result.Message = "Provider CLI is already up to date"
		return result, nil
	}

	npmSpec := ManagedNPMPackageInstallerSpec{
		PackageName:     spec.Update.PackageName,
		PackageVersion:  update.LatestVersion,
		BinaryName:      spec.Update.BinaryName,
		IncludeOptional: spec.Update.IncludeOptional,
	}
	lockSpec := InstallerSpec{Kind: InstallerKindManagedNPMPackage, ManagedNPM: &npmSpec}
	releaseLock, err := newInstallCommandLock(installerLockCommand(lockSpec)).Acquire(updateCtx)
	if err != nil {
		return updateActionErrorResult(result, err, s.installTimeout()), nil
	}
	defer releaseLock()

	setActiveAction(updateCtx, spec.Provider, ActiveAction{ID: ActionUpdate, Status: "running", Step: "update"})
	commandResult, err := s.runManagedNPMPackageAction(updateCtx, spec.Provider, ActionUpdate, npmSpec, runtimeResolution.CLIPath)
	result.Command = providerUpdateDisplayCommand(npmSpec)
	result.ExitCode = intPointer(commandResult.ExitCode)
	result.Stdout = trimActionOutput(commandResult.Stdout)
	result.Stderr = trimActionOutput(commandResult.Stderr)
	if err != nil {
		return updateActionErrorResult(result, err, s.installTimeout()), nil
	}
	if commandResult.ExitCode != 0 {
		result.Status = RunActionFailed
		result.ReasonCode = "update_command_failed"
		result.Message = firstNonBlank(result.Stderr, result.Stdout, "Update command failed")
		return result, nil
	}

	setActiveAction(updateCtx, spec.Provider, ActiveAction{ID: ActionUpdate, Status: "running", Step: "verify", Stdout: result.Stdout})
	probe, err := s.Probe(ctx, ProbeInput{Provider: spec.Provider})
	if err != nil {
		return RunActionResult{}, err
	}
	result.Probe = &probe
	if probe.Status != ProbeReady {
		result.Status = RunActionFailed
		result.ReasonCode = "post_update_probe_failed"
		result.Message = firstNonBlank(probe.Message, probe.ReasonCode, "Agent provider runtime probe failed after update")
		return result, nil
	}
	result.Status = RunActionCompleted
	return result, nil
}

func providerUpdateDisplayCommand(spec ManagedNPMPackageInstallerSpec) string {
	parts := []string{"npm install -g", managedNPMPackageSpec(spec)}
	if spec.IncludeOptional {
		parts = append(parts, "--include=optional")
	}
	return strings.Join(parts, " ")
}

func updateActionErrorResult(result RunActionResult, err error, timeout time.Duration) RunActionResult {
	result.Status = RunActionFailed
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		result.ReasonCode = "update_timed_out"
		result.Message = "Update command timed out after " + timeout.String()
	case errors.Is(err, context.Canceled):
		result.ReasonCode = "update_canceled"
		result.Message = err.Error()
	default:
		result.ReasonCode = "update_start_failed"
		result.Message = err.Error()
	}
	return result
}
