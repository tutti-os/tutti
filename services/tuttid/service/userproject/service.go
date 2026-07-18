package userproject

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var (
	ErrInvalidArgument = errors.New("invalid user project request")
	ErrNotDirectory    = errors.New("user project path is not a directory")
)

type Service struct {
	Store     workspacedata.UserProjectStore
	Publisher EventPublisher
}

type EventPublisher interface {
	PublishUserProjectUpdated(context.Context, []userprojectbiz.Project) error
}

type UseInput struct {
	Path             string
	LastUsedAtUnixMS int64
}

type UseManyInput struct {
	Paths []string
}

type DeleteInput struct {
	Path string
}

type MoveInput struct {
	ProjectID       string
	BeforeProjectID *string
}

type PinInput struct {
	ProjectID string
	Pinned    bool
}

type CheckPathInput struct {
	Path string
}

type PathCheck struct {
	Path        string
	Exists      bool
	IsDirectory bool
}

func (s Service) List(ctx context.Context) ([]userprojectbiz.Project, error) {
	if s.Store == nil {
		return nil, errors.New("user project store is not configured")
	}
	return s.Store.ListUserProjects(ctx)
}

func (Service) CheckPath(_ context.Context, input CheckPathInput) (PathCheck, error) {
	path := strings.TrimSpace(input.Path)
	if path == "" {
		return PathCheck{}, ErrInvalidArgument
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return PathCheck{}, fmt.Errorf("%w: %w", ErrInvalidArgument, err)
	}
	info, err := os.Stat(absolute)
	if err != nil {
		if os.IsNotExist(err) {
			return PathCheck{Path: absolute}, nil
		}
		return PathCheck{}, fmt.Errorf("check user project path: %w", err)
	}
	return PathCheck{
		Path:        absolute,
		Exists:      true,
		IsDirectory: info.IsDir(),
	}, nil
}

func (s Service) Use(ctx context.Context, input UseInput) (userprojectbiz.Project, error) {
	if s.Store == nil {
		return userprojectbiz.Project{}, errors.New("user project store is not configured")
	}

	projectPath, err := normalizeDirectoryPath(input.Path)
	if err != nil {
		return userprojectbiz.Project{}, err
	}
	info, err := os.Stat(projectPath)
	if err != nil {
		return userprojectbiz.Project{}, ErrNotDirectory
	}
	if !info.IsDir() {
		return userprojectbiz.Project{}, ErrNotDirectory
	}

	project, err := s.Store.PutUserProject(ctx, userprojectbiz.Project{
		ID:               projectID(projectPath),
		Path:             projectPath,
		Label:            userprojectbiz.LabelFromPath(projectPath),
		SectionKey:       userprojectbiz.SectionKeyFromPath(projectPath),
		LastUsedAtUnixMS: input.LastUsedAtUnixMS,
	})
	if err != nil {
		return userprojectbiz.Project{}, err
	}
	s.publishCurrentProjects(ctx)
	return project, nil
}

// UseMany registers projects so the resulting new-project order matches the
// caller's input order even though individual new projects are inserted first.
// Errors are aligned with Paths; a nil entry means that path was registered.
func (s Service) UseMany(ctx context.Context, input UseManyInput) []error {
	errorsByIndex := make([]error, len(input.Paths))
	lastUsedAtUnixMS := time.Now().UTC().UnixMilli() + int64(len(input.Paths))
	for index := len(input.Paths) - 1; index >= 0; index-- {
		_, errorsByIndex[index] = s.Use(ctx, UseInput{
			Path:             input.Paths[index],
			LastUsedAtUnixMS: lastUsedAtUnixMS - int64(index),
		})
	}
	return errorsByIndex
}

func (s Service) Delete(ctx context.Context, input DeleteInput) error {
	if s.Store == nil {
		return errors.New("user project store is not configured")
	}
	projectPath, err := normalizeDirectoryPath(input.Path)
	if err != nil {
		return err
	}
	// Delete by the normalized path rather than a recomputed id: `path` is
	// the table's durable UNIQUE key, while `projectID(projectPath)` is
	// derived fresh on every call and is only guaranteed to match the id that
	// was stored at registration time. If that derivation ever drifts (e.g.
	// symlink resolution behaves differently the second time around), a
	// delete keyed on the recomputed id silently affects zero rows and the
	// "removed" project never actually goes away.
	if err := s.Store.DeleteUserProjectByPath(ctx, projectPath); err != nil {
		return err
	}
	s.publishCurrentProjects(ctx)
	return nil
}

func (s Service) Move(ctx context.Context, input MoveInput) ([]userprojectbiz.Project, error) {
	if s.Store == nil {
		return nil, errors.New("user project store is not configured")
	}
	projectID := strings.TrimSpace(input.ProjectID)
	if projectID == "" {
		return nil, ErrInvalidArgument
	}
	var beforeProjectID *string
	if input.BeforeProjectID != nil {
		normalized := strings.TrimSpace(*input.BeforeProjectID)
		if normalized == "" {
			return nil, ErrInvalidArgument
		}
		beforeProjectID = &normalized
	}
	projects, err := s.Store.MoveUserProject(ctx, projectID, beforeProjectID)
	if err != nil {
		if errors.Is(err, workspacedata.ErrUserProjectNotFound) || errors.Is(err, workspacedata.ErrUserProjectPartitionMismatch) {
			return nil, ErrInvalidArgument
		}
		return nil, err
	}
	if s.Publisher != nil {
		_ = s.Publisher.PublishUserProjectUpdated(ctx, projects)
	}
	return projects, nil
}

func (s Service) Pin(ctx context.Context, input PinInput) ([]userprojectbiz.Project, error) {
	if s.Store == nil {
		return nil, errors.New("user project store is not configured")
	}
	projectID := strings.TrimSpace(input.ProjectID)
	if projectID == "" {
		return nil, ErrInvalidArgument
	}
	projects, changed, err := s.Store.PinUserProject(ctx, projectID, input.Pinned)
	if err != nil {
		if errors.Is(err, workspacedata.ErrUserProjectNotFound) {
			return nil, ErrInvalidArgument
		}
		return nil, err
	}
	if changed && s.Publisher != nil {
		_ = s.Publisher.PublishUserProjectUpdated(ctx, projects)
	}
	return projects, nil
}

func (s Service) publishCurrentProjects(ctx context.Context) {
	if s.Publisher == nil {
		return
	}
	projects, err := s.Store.ListUserProjects(ctx)
	if err != nil {
		return
	}
	_ = s.Publisher.PublishUserProjectUpdated(ctx, projects)
}

func normalizeDirectoryPath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", ErrInvalidArgument
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", ErrInvalidArgument
	}
	evaluated, err := filepath.EvalSymlinks(absolute)
	if err == nil {
		absolute = evaluated
	}
	return absolute, nil
}

func projectID(path string) string {
	sum := sha256.Sum256([]byte(path))
	return "user_project_" + hex.EncodeToString(sum[:])[:24]
}
