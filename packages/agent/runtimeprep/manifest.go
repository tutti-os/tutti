package runtimeprep

import (
	"strings"
	"time"
)

const SidecarManifestFileName = "sidecar-manifest.json"

type ManifestInput struct {
	AgentSessionID string
	Provider       string
	Cwd            string
	RuntimeRoot    string
}

type Manifest struct {
	Version         int           `json:"version"`
	AgentSessionID  string        `json:"agentSessionId"`
	Provider        string        `json:"provider"`
	Cwd             string        `json:"cwd"`
	RuntimeRoot     string        `json:"runtimeRoot"`
	ManagedFiles    []ManagedFile `json:"managedFiles,omitempty"`
	CreatedAtUnixMS int64         `json:"createdAtUnixMs"`
	UpdatedAtUnixMS int64         `json:"updatedAtUnixMs"`
}

type ManagedFile struct {
	Path    string `json:"path"`
	Kind    string `json:"kind"`
	Created bool   `json:"created,omitempty"`
}

type ManagedBlockWriteResult struct {
	Path    string
	Created bool
}

type StoreCleanupInput struct {
	WorkspaceID    string
	AgentSessionID string
	RuntimeRoot    string
}

func NewManifest(input ManifestInput) *Manifest {
	now := time.Now().UTC().UnixMilli()
	return &Manifest{
		Version:         1,
		AgentSessionID:  strings.TrimSpace(input.AgentSessionID),
		Provider:        strings.TrimSpace(input.Provider),
		Cwd:             strings.TrimSpace(input.Cwd),
		RuntimeRoot:     strings.TrimSpace(input.RuntimeRoot),
		CreatedAtUnixMS: now,
		UpdatedAtUnixMS: now,
	}
}

func (m *Manifest) RecordManagedFile(path string, kind string, created bool) {
	if m == nil {
		return
	}
	path = strings.TrimSpace(path)
	kind = strings.TrimSpace(kind)
	if path == "" {
		return
	}
	for index, existing := range m.ManagedFiles {
		if existing.Path == path {
			if kind != "" {
				m.ManagedFiles[index].Kind = kind
			}
			m.ManagedFiles[index].Created = m.ManagedFiles[index].Created || created
			return
		}
	}
	m.ManagedFiles = append(m.ManagedFiles, ManagedFile{
		Path:    path,
		Kind:    kind,
		Created: created,
	})
}
