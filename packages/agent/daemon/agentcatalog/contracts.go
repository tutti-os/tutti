// Package agentcatalog owns host-neutral catalog snapshot coordination.
//
// Hosts retain ownership of targets, provider processes, persistence and
// transport projection. This package only defines the normalized model facet
// and the policy used to resolve it consistently for composer and validation.
package agentcatalog

import (
	"context"
	"time"
)

type Facet string

const FacetModels Facet = "models"

type SnapshotSource string

const (
	SnapshotSourceRuntime  SnapshotSource = "runtime"
	SnapshotSourceMemory   SnapshotSource = "memory"
	SnapshotSourceDurable  SnapshotSource = "durable"
	SnapshotSourceResolver SnapshotSource = "resolver"
	SnapshotSourceFallback SnapshotSource = "fallback"
)

type SnapshotFreshness string

const (
	SnapshotFreshnessFresh   SnapshotFreshness = "fresh"
	SnapshotFreshnessStale   SnapshotFreshness = "stale"
	SnapshotFreshnessPending SnapshotFreshness = "pending"
)

type ReadPolicy string

const (
	ReadPolicyInteractive ReadPolicy = "interactive"
	ReadPolicyWait        ReadPolicy = "wait"
	ReadPolicyCacheOnly   ReadPolicy = "cache_only"
)

type ScopeKind string

const (
	ScopeKindAccount  ScopeKind = "account"
	ScopeKindProvider ScopeKind = "provider"
	ScopeKindCWD      ScopeKind = "cwd"
	ScopeKindTarget   ScopeKind = "target"
)

// SnapshotKey is deliberately structured. AuthRevision is an opaque host-
// supplied revision and must never contain credentials or raw config data.
type SnapshotKey struct {
	Facet                   Facet
	ProviderID              string
	AgentTargetID           string
	ScopeKind               ScopeKind
	ScopeValue              string
	AuthRevision            string
	DescriptorSchemaVersion int
}

type ModelReasoningOption struct {
	Value       string `json:"value"`
	Description string `json:"description,omitempty"`
}

// ModelOption is the persistence-safe allowlist for one advertised model.
type ModelOption struct {
	Value                      string                 `json:"value"`
	Label                      string                 `json:"label,omitempty"`
	Description                string                 `json:"description,omitempty"`
	IsDefault                  bool                   `json:"isDefault,omitempty"`
	DefaultReasoningEffort     string                 `json:"defaultReasoningEffort,omitempty"`
	ReasoningEffortsAdvertised bool                   `json:"reasoningEffortsAdvertised,omitempty"`
	SupportedReasoningEfforts  []ModelReasoningOption `json:"supportedReasoningEfforts,omitempty"`
	SupportsImageInput         *bool                  `json:"supportsImageInput,omitempty"`
}

type ModelSnapshot struct {
	Models         []ModelOption `json:"models"`
	Revision       string        `json:"revision"`
	ResolverSource string        `json:"resolverSource,omitempty"`
	Complete       bool          `json:"complete"`
}

type FacetSnapshot[T any] struct {
	Value      T
	Source     SnapshotSource
	Freshness  SnapshotFreshness
	FetchedAt  time.Time
	Refreshing bool
	ErrorCode  string
}

type ModelDiscoveryPolicy struct {
	Enabled              bool
	ReuseRuntimeSnapshot bool
	RuntimeAuthoritative bool
	PersistLastGood      bool
	FreshTTL             time.Duration
	MaxStale             time.Duration
	ColdResolverKind     string
	FallbackModels       []ModelOption
}

type ResolveModelsInput struct {
	Key           SnapshotKey
	Policy        ModelDiscoveryPolicy
	ReadPolicy    ReadPolicy
	SelectedModel string
	ResolverInput any
}

type ResolveModelsResult = FacetSnapshot[ModelSnapshot]

type RuntimeCatalogSnapshot struct {
	Key       SnapshotKey
	Models    ModelSnapshot
	FetchedAt time.Time
}

type InvalidateInput struct {
	Facet         Facet
	ProviderID    string
	AgentTargetID string
	ScopeKind     ScopeKind
	ScopeValue    string
	AuthRevision  string
}

type ColdResolver interface {
	ResolveModels(context.Context, ResolveModelsInput) (ModelSnapshot, error)
}

type ColdResolverFunc func(context.Context, ResolveModelsInput) (ModelSnapshot, error)

func (f ColdResolverFunc) ResolveModels(ctx context.Context, input ResolveModelsInput) (ModelSnapshot, error) {
	return f(ctx, input)
}

type StoredSnapshot struct {
	Key        SnapshotKey
	Models     ModelSnapshot
	Source     SnapshotSource
	FetchedAt  time.Time
	ExpiresAt  time.Time
	StaleUntil time.Time
}

// SnapshotStore persists normalized successful model facets only.
type SnapshotStore interface {
	Load(context.Context, SnapshotKey) (StoredSnapshot, bool, error)
	Save(context.Context, StoredSnapshot) error
	Delete(context.Context, InvalidateInput) error
}

type ModelQueryService interface {
	ResolveModels(context.Context, ResolveModelsInput) (ResolveModelsResult, error)
	ValidateModel(context.Context, ResolveModelsInput, string) error
	IngestRuntimeSnapshot(context.Context, RuntimeCatalogSnapshot) error
	Invalidate(context.Context, InvalidateInput) error
}
