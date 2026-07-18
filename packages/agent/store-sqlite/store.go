package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Querier is the query surface handed to injected queriers. The store passes
// the *sql.Tx of the transaction it is currently running (or its *sql.DB when
// outside one); implementations must run all reads through it so they share
// the store's connection.
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// ProjectPathsQuerier lists project root paths used to classify agent
// sessions into rail sections. Hosts typically back this with their own
// project table in the same database.
type ProjectPathsQuerier interface {
	ProjectPaths(ctx context.Context, q Querier) ([]string, error)
}

// Options injects the host concerns the store was decoupled from. Every
// field is optional; the zero value yields a store with no workspace
// validation, no project-based rail classification, and no target
// normalization or seeding.
type Options struct {
	// WorkspaceExists validates a workspace ID before writes that create
	// rows for it (and before generated-file listings). It must return an
	// error for unknown workspaces; nil disables validation.
	WorkspaceExists func(ctx context.Context, workspaceID string) error
	// ProjectPaths supplies project roots for rail section classification;
	// nil classifies every session into the conversations section.
	ProjectPaths ProjectPathsQuerier
	// NormalizeTarget canonicalizes agent targets on write and on read;
	// nil stores and returns targets verbatim.
	NormalizeTarget func(Target) (Target, error)
	// IsSkippableTargetError reports whether a normalization error on a
	// stored row should skip that row (with a warning) instead of failing
	// the whole listing.
	IsSkippableTargetError func(error) bool
	// SeedSystemTargets returns targets inserted (INSERT OR IGNORE) on every
	// Migrate, stamped with the given time.
	SeedSystemTargets func(nowUnixMS int64) []Target
	// LegacySystemTargetIDRenames maps retired system target IDs to their
	// current IDs; Migrate rewrites sessions and target rows accordingly.
	LegacySystemTargetIDRenames map[string]string
	// TargetIDBackfillByProvider maps a provider to the agent target ID
	// assigned to its sessions that predate target tracking.
	TargetIDBackfillByProvider map[string]string
	// TransactionParticipant joins host-owned durable markers to canonical
	// writes. The participant runs before commit through a restricted writer;
	// returning an error rolls back both the canonical facts and participant
	// writes. It must not perform network IO or other non-transactional work.
	TransactionParticipant TransactionParticipant
}

// Store is the SQLite implementation of Repository plus agent target
// storage. It owns the workspace_agent_sessions, workspace_agent_messages,
// and agent_targets tables and records applied migrations in
// agent_store_schema_migrations.
type Store struct {
	db   *sql.DB
	opts Options
}

// New wraps an opened database. The caller keeps ownership of db (including
// closing it) and must call Migrate before using the store.
func New(db *sql.DB, opts Options) *Store {
	return &Store{db: db, opts: opts}
}

func (s *Store) ensureWorkspaceExists(ctx context.Context, workspaceID string) error {
	if s.opts.WorkspaceExists == nil {
		return nil
	}
	return s.opts.WorkspaceExists(ctx, workspaceID)
}

type rowScanner interface {
	Scan(dest ...any) error
}

func unixMs(value time.Time) int64 {
	return value.UnixMilli()
}

func rowsWereAffected(result sql.Result, operation string) (bool, error) {
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("%s rows affected: %w", operation, err)
	}
	return rowsAffected > 0, nil
}

func nullString(value string) sql.NullString {
	value = strings.TrimSpace(value)
	if value == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: value, Valid: true}
}

func marshalJSONMap(payload map[string]any) (string, error) {
	if len(payload) == 0 {
		return "{}", nil
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode workspace agent session json: %w", err)
	}
	return string(data), nil
}

func unmarshalJSONMap(input string) (map[string]any, error) {
	if strings.TrimSpace(input) == "" {
		return nil, nil
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(input), &payload); err != nil {
		return nil, err
	}
	if len(payload) == 0 {
		return nil, nil
	}
	return payload, nil
}

func cloneJSONMap(payload map[string]any) map[string]any {
	if len(payload) == 0 {
		return nil
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		out[key] = value
	}
	return out
}
