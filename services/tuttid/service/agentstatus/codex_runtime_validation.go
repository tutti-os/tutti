package agentstatus

import (
	"context"
	"strings"

	"golang.org/x/sync/errgroup"
)

const codexCandidateValidationConcurrency = 3

type codexRuntimeCandidateValidationState string

const (
	codexRuntimeCandidateValidationReady       codexRuntimeCandidateValidationState = "ready"
	codexRuntimeCandidateValidationUnsupported codexRuntimeCandidateValidationState = "unsupported"
	codexRuntimeCandidateValidationFailed      codexRuntimeCandidateValidationState = "failed"
)

// codexRuntimeCandidateValidation keeps runtime facts separate from the
// selection decision. A successful app-server handshake establishes runtime
// capability; the version policy determines whether that candidate is eligible
// for automatic selection.
type codexRuntimeCandidateValidation struct {
	Candidate        codexRuntimeCandidate
	Version          string
	VersionSupported bool
	Probe            CodexProbeEvidence
	PackageLayout    CodexPackageLayoutEvidence
	State            codexRuntimeCandidateValidationState
	ReasonCode       string
}

func (s Service) validateCodexRuntimeCandidates(
	ctx context.Context,
	spec ProviderSpec,
	candidates []codexRuntimeCandidate,
) []codexRuntimeCandidateValidation {
	if len(candidates) == 0 {
		return nil
	}
	result := make([]codexRuntimeCandidateValidation, len(candidates))
	group, groupCtx := errgroup.WithContext(baseContext(ctx))
	jobs := make(chan int)
	workers := min(codexCandidateValidationConcurrency, len(candidates))
	for range workers {
		group.Go(func() error {
			for {
				select {
				case <-groupCtx.Done():
					return nil
				case index, ok := <-jobs:
					if !ok {
						return nil
					}
					result[index] = s.validateCodexRuntimeCandidate(groupCtx, spec, candidates[index])
				}
			}
		})
	}
dispatch:
	for index := range candidates {
		select {
		case <-groupCtx.Done():
			break dispatch
		case jobs <- index:
		}
	}
	close(jobs)
	_ = group.Wait()
	return result
}

func (s Service) validateCodexRuntimeCandidate(
	ctx context.Context,
	spec ProviderSpec,
	candidate codexRuntimeCandidate,
) codexRuntimeCandidateValidation {
	env := s.commandResolver().Env(s.adapterCommandEnv(ctx, spec))
	version := s.providerCLIVersion(ctx, spec, candidate.LauncherPath, env)
	probe := s.probeCodexRuntimeCandidate(ctx, candidate.LauncherPath, env)
	layout := s.scanCodexPackageLayout(candidate.LauncherPath)
	result := codexRuntimeCandidateValidation{
		Candidate:        candidate,
		Version:          version,
		VersionSupported: providerCLIVersionMeetsMinimum(spec, version),
		Probe:            probe,
		PackageLayout:    layout,
	}
	switch {
	case !probe.ProtocolReady:
		result.State = codexRuntimeCandidateValidationFailed
		result.ReasonCode = firstNonBlank(probe.Category, "acp_adapter_launch_failed")
	case !result.VersionSupported:
		result.State = codexRuntimeCandidateValidationUnsupported
		result.ReasonCode = "codex_version_unsupported"
	default:
		result.State = codexRuntimeCandidateValidationReady
	}
	return result
}

func (s Service) probeCodexRuntimeCandidate(ctx context.Context, launcherPath string, env []string) CodexProbeEvidence {
	launcherPath = strings.TrimSpace(launcherPath)
	if launcherPath == "" {
		return CodexProbeEvidence{Category: "acp_adapter_not_found"}
	}
	release, acquired := s.DetectionCommands.acquire(ctx)
	if !acquired {
		return CodexProbeEvidence{Category: "probe_canceled"}
	}
	defer release()
	return s.probeCodexAppServer(ctx, []string{launcherPath, "app-server"}, env)
}

type codexRuntimeAutoSelection struct {
	CandidateIndex int
	Launchable     bool
	ReasonCode     string
}

// selectCodexRuntimeAutomatically keeps the current resolver ordering as the
// tie-breaker, but skips a broken or unsupported shadowing installation. It is
// deliberately pure so the persisted explicit-selection policy can layer on
// top without duplicating health ranking.
func selectCodexRuntimeAutomatically(
	candidates []codexRuntimeCandidateValidation,
) codexRuntimeAutoSelection {
	for index, candidate := range candidates {
		if candidate.State == codexRuntimeCandidateValidationReady {
			return codexRuntimeAutoSelection{CandidateIndex: index, Launchable: true, ReasonCode: "first_ready_candidate"}
		}
	}
	if len(candidates) == 0 {
		return codexRuntimeAutoSelection{CandidateIndex: -1, ReasonCode: "cli_not_found"}
	}
	return codexRuntimeAutoSelection{CandidateIndex: 0, ReasonCode: "no_ready_candidate"}
}
