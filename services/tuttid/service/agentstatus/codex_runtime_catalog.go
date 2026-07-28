package agentstatus

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

type CodexRuntimeSelectionMode string

const (
	CodexRuntimeSelectionAuto     CodexRuntimeSelectionMode = "auto"
	CodexRuntimeSelectionExplicit CodexRuntimeSelectionMode = "explicit"
)

type CodexRuntimeSelectionState string

const (
	CodexRuntimeSelectionAutomatic CodexRuntimeSelectionState = "automatic"
	CodexRuntimeSelectionSelected  CodexRuntimeSelectionState = "selected"
	CodexRuntimeSelectionStale     CodexRuntimeSelectionState = "stale"
)

type CodexRuntimeCatalog struct {
	CapturedAt time.Time
	Provider   string
	Revision   string
	Selection  CodexRuntimeSelection
	Candidates []CodexRuntimeCatalogCandidate
}

type CodexRuntimeCatalogCandidate struct {
	ID              string
	LauncherPath    string
	PackageRoot     string
	Sources         []string
	Version         string
	State           string
	ReasonCode      string
	AppServerReady  bool
	PackageLayoutOK bool
}

type CodexRuntimeSelection struct {
	Mode         CodexRuntimeSelectionMode
	State        CodexRuntimeSelectionState
	CandidateID  string
	LauncherPath string
	UpdatedAt    *time.Time
}

type SetCodexRuntimeSelectionInput struct {
	Mode        CodexRuntimeSelectionMode
	CandidateID string
	Revision    string
}

var ErrRuntimeCatalogRevisionConflict = errors.New("codex runtime catalog revision conflicts with current discovery")
var ErrRuntimeCandidateNotFound = errors.New("codex runtime candidate not found")
var ErrRuntimeSelectionStoreUnavailable = errors.New("codex runtime selection store is unavailable")

// GetCodexRuntimeCatalog discovers and validates every logically distinct
// Codex installation. It is intentionally independent from status caching: a
// user choosing a local executable must see the current filesystem state.
func (s Service) GetCodexRuntimeCatalog(ctx context.Context, provider string) (CodexRuntimeCatalog, error) {
	if agentproviderbiz.Normalize(provider) != agentproviderbiz.Codex {
		return CodexRuntimeCatalog{}, ErrInvalidProvider
	}
	specs, err := s.registry().Select([]string{agentproviderbiz.Codex})
	if err != nil || len(specs) == 0 {
		return CodexRuntimeCatalog{}, ErrInvalidProvider
	}
	validations := s.validateCodexRuntimeCandidates(ctx, specs[0], s.discoverCodexRuntimeCandidates(ctx, specs[0]))
	catalog := codexRuntimeCatalogFromValidations(validations)
	selection, found, err := s.codexRuntimeSelection(ctx)
	if err != nil {
		return CodexRuntimeCatalog{}, err
	}
	catalog.Selection = codexRuntimeCatalogSelection(catalog.Candidates, selection, found)
	return catalog, nil
}

func (s Service) SetCodexRuntimeSelection(ctx context.Context, input SetCodexRuntimeSelectionInput) (CodexRuntimeCatalog, error) {
	if s.CodexRuntimeSelectionStore == nil {
		return CodexRuntimeCatalog{}, ErrRuntimeSelectionStoreUnavailable
	}
	catalog, err := s.GetCodexRuntimeCatalog(ctx, agentproviderbiz.Codex)
	if err != nil {
		return CodexRuntimeCatalog{}, err
	}
	if input.Mode == CodexRuntimeSelectionAuto {
		if err := s.CodexRuntimeSelectionStore.DeleteAgentProviderRuntimeSelection(ctx, agentproviderbiz.Codex); err != nil {
			return CodexRuntimeCatalog{}, err
		}
		catalog.Selection = codexRuntimeCatalogSelection(catalog.Candidates, agentproviderbiz.RuntimeSelection{}, false)
		return catalog, nil
	}
	if input.Mode != CodexRuntimeSelectionExplicit {
		return CodexRuntimeCatalog{}, errors.New("codex runtime selection mode must be auto or explicit")
	}
	if strings.TrimSpace(input.Revision) == "" || input.Revision != catalog.Revision {
		return CodexRuntimeCatalog{}, ErrRuntimeCatalogRevisionConflict
	}
	for _, candidate := range catalog.Candidates {
		if candidate.ID != input.CandidateID {
			continue
		}
		selection, err := s.CodexRuntimeSelectionStore.PutAgentProviderRuntimeSelection(ctx, agentproviderbiz.RuntimeSelection{
			Provider:     agentproviderbiz.Codex,
			LauncherPath: candidate.LauncherPath,
		})
		if err != nil {
			return CodexRuntimeCatalog{}, err
		}
		catalog.Selection = codexRuntimeCatalogSelection(catalog.Candidates, selection, true)
		return catalog, nil
	}
	return CodexRuntimeCatalog{}, ErrRuntimeCandidateNotFound
}

func (s Service) codexRuntimeSelection(ctx context.Context) (agentproviderbiz.RuntimeSelection, bool, error) {
	if s.CodexRuntimeSelectionStore == nil {
		return agentproviderbiz.RuntimeSelection{}, false, ErrRuntimeSelectionStoreUnavailable
	}
	return s.CodexRuntimeSelectionStore.GetAgentProviderRuntimeSelection(ctx, agentproviderbiz.Codex)
}

func codexRuntimeCatalogFromValidations(validations []codexRuntimeCandidateValidation) CodexRuntimeCatalog {
	candidates := make([]CodexRuntimeCatalogCandidate, 0, len(validations))
	for _, validation := range validations {
		candidate := validation.Candidate
		candidates = append(candidates, CodexRuntimeCatalogCandidate{
			ID:              codexRuntimeCandidateID(candidate),
			LauncherPath:    candidate.LauncherPath,
			PackageRoot:     candidate.PackageRoot,
			Sources:         codexRuntimeCandidateSourceStrings(candidate.Sources),
			Version:         validation.Version,
			State:           string(validation.State),
			ReasonCode:      validation.ReasonCode,
			AppServerReady:  validation.Probe.ProtocolReady,
			PackageLayoutOK: codexRuntimePackageLayoutOK(validation.PackageLayout),
		})
	}
	return CodexRuntimeCatalog{
		CapturedAt: time.Now().UTC(),
		Provider:   agentproviderbiz.Codex,
		Revision:   codexRuntimeCatalogRevision(candidates),
		Candidates: candidates,
	}
}

func codexRuntimeCandidateSourceStrings(sources []codexRuntimeCandidateSource) []string {
	result := make([]string, 0, len(sources))
	for _, source := range sources {
		result = append(result, string(source))
	}
	return result
}

func codexRuntimePackageLayoutOK(layout CodexPackageLayoutEvidence) bool {
	return (layout.PlatformPackagePresence == CodexPathPresent && layout.PlatformBinaryPresence == CodexPathPresent) ||
		(layout.PlatformPackagePresence == CodexPathNotApplicable && layout.PlatformBinaryPresence == CodexPathNotApplicable)
}

func codexRuntimeCatalogSelection(candidates []CodexRuntimeCatalogCandidate, selection agentproviderbiz.RuntimeSelection, found bool) CodexRuntimeSelection {
	if !found {
		return CodexRuntimeSelection{Mode: CodexRuntimeSelectionAuto, State: CodexRuntimeSelectionAutomatic}
	}
	result := CodexRuntimeSelection{
		Mode:         CodexRuntimeSelectionExplicit,
		State:        CodexRuntimeSelectionStale,
		LauncherPath: selection.LauncherPath,
		UpdatedAt:    &selection.UpdatedAt,
	}
	for _, candidate := range candidates {
		if candidate.LauncherPath == selection.LauncherPath {
			result.State = CodexRuntimeSelectionSelected
			result.CandidateID = candidate.ID
			break
		}
	}
	return result
}

func codexRuntimeCandidateID(candidate codexRuntimeCandidate) string {
	hash := sha256.Sum256([]byte(strings.TrimSpace(candidate.LauncherPath)))
	return "codex-" + hex.EncodeToString(hash[:8])
}

func codexRuntimeCatalogRevision(candidates []CodexRuntimeCatalogCandidate) string {
	hash := sha256.New()
	for _, candidate := range candidates {
		_, _ = hash.Write([]byte(candidate.ID))
		_, _ = hash.Write([]byte{'\n'})
	}
	return hex.EncodeToString(hash.Sum(nil)[:16])
}
