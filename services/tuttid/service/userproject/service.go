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

	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

var (
	ErrInvalidArgument = errors.New("invalid user project request")
	ErrNotDirectory    = errors.New("user project path is not a directory")
)

type Service struct {
	Store workspacedata.UserProjectStore
}

type UseInput struct {
	Path             string
	LastUsedAtUnixMS int64
}

type DeleteInput struct {
	Path string
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
	projects, err := s.Store.ListUserProjects(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]userprojectbiz.Project, 0, len(projects))
	for _, project := range projects {
		available, prune := projectDirectoryStatus(project.Path)
		if available {
			result = append(result, project)
			continue
		}
		if !prune {
			continue
		}
		if err := s.Store.DeleteUserProject(ctx, project.ID); err != nil {
			return nil, fmt.Errorf("prune unavailable user project: %w", err)
		}
	}
	return result, nil
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

	return s.Store.PutUserProject(ctx, userprojectbiz.Project{
		ID:               projectID(projectPath),
		Path:             projectPath,
		Label:            userprojectbiz.LabelFromPath(projectPath),
		LastUsedAtUnixMS: input.LastUsedAtUnixMS,
	})
}

func (s Service) Delete(ctx context.Context, input DeleteInput) error {
	if s.Store == nil {
		return errors.New("user project store is not configured")
	}
	projectPath, err := normalizeDirectoryPath(input.Path)
	if err != nil {
		return err
	}
	return s.Store.DeleteUserProject(ctx, projectID(projectPath))
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

func projectDirectoryStatus(path string) (available bool, prune bool) {
	info, err := os.Stat(strings.TrimSpace(path))
	if err != nil {
		return false, os.IsNotExist(err)
	}
	if !info.IsDir() {
		return false, true
	}
	return true, false
}

func projectID(path string) string {
	sum := sha256.Sum256([]byte(path))
	return "user_project_" + hex.EncodeToString(sum[:])[:24]
}
