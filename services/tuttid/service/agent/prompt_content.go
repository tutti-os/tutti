package agent

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/google/uuid"
)

const maxPromptImageBlocks = 8

type PromptAttachmentStore struct {
	RootDir string
}

func TextPromptContent(text string) []PromptContentBlock {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	return []PromptContentBlock{{Type: "text", Text: text}}
}

func normalizePromptContent(content []PromptContentBlock) ([]PromptContentBlock, string, error) {
	normalized := make([]PromptContentBlock, 0, len(content))
	imageCount := 0
	textParts := make([]string, 0, len(content))
	hasInput := false
	for _, block := range content {
		switch strings.TrimSpace(block.Type) {
		case "text":
			text := strings.TrimSpace(block.Text)
			if text == "" {
				continue
			}
			hasInput = true
			textParts = append(textParts, text)
			normalized = append(normalized, PromptContentBlock{
				Type: "text",
				Text: text,
			})
		case "image":
			imageCount++
			if imageCount > maxPromptImageBlocks {
				return nil, "", ErrInvalidArgument
			}
			mimeType := strings.TrimSpace(block.MimeType)
			if !supportedPromptImageMimeType(mimeType) {
				return nil, "", ErrInvalidArgument
			}
			if strings.TrimSpace(block.Data) == "" && strings.TrimSpace(block.AttachmentID) == "" {
				return nil, "", ErrInvalidArgument
			}
			data := strings.TrimSpace(block.Data)
			if data != "" {
				if _, err := base64.StdEncoding.DecodeString(data); err != nil {
					return nil, "", ErrInvalidArgument
				}
			}
			hasInput = true
			normalized = append(normalized, PromptContentBlock{
				Type:         "image",
				MimeType:     mimeType,
				Data:         data,
				AttachmentID: strings.TrimSpace(block.AttachmentID),
				Name:         strings.TrimSpace(block.Name),
			})
		case "skill", "mention":
			name := strings.TrimSpace(block.Name)
			path := strings.TrimSpace(block.Path)
			if name == "" || path == "" {
				return nil, "", ErrInvalidArgument
			}
			normalized = append(normalized, PromptContentBlock{
				Type: strings.TrimSpace(block.Type),
				Name: name,
				Path: path,
			})
		default:
			return nil, "", ErrInvalidArgument
		}
	}
	if !hasInput {
		return nil, "", ErrInvalidArgument
	}
	return normalized, strings.Join(textParts, "\n"), nil
}

func supportedPromptImageMimeType(mimeType string) bool {
	switch strings.TrimSpace(mimeType) {
	case "image/png", "image/jpeg", "image/webp":
		return true
	default:
		return false
	}
}

func (s PromptAttachmentStore) PersistRequestContent(workspaceID, agentSessionID string, content []PromptContentBlock) ([]PromptContentBlock, error) {
	if len(content) == 0 {
		return nil, ErrInvalidArgument
	}
	out := make([]PromptContentBlock, 0, len(content))
	for _, block := range content {
		if block.Type != "image" || strings.TrimSpace(block.Data) == "" {
			out = append(out, block)
			continue
		}
		attachmentID := uuid.NewString()
		path, err := s.attachmentPath(workspaceID, agentSessionID, attachmentID, block.MimeType)
		if err != nil {
			return nil, err
		}
		data, err := base64.StdEncoding.DecodeString(strings.TrimSpace(block.Data))
		if err != nil {
			return nil, ErrInvalidArgument
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, fmt.Errorf("create agent prompt attachment directory: %w", err)
		}
		if err := os.WriteFile(path, data, 0o600); err != nil {
			return nil, fmt.Errorf("write agent prompt attachment: %w", err)
		}
		out = append(out, PromptContentBlock{
			Type:         "image",
			MimeType:     block.MimeType,
			AttachmentID: attachmentID,
			Name:         block.Name,
		})
	}
	return out, nil
}

func (s PromptAttachmentStore) HydrateRuntimeContent(workspaceID, agentSessionID string, content []PromptContentBlock) ([]PromptContentBlock, error) {
	out := make([]PromptContentBlock, 0, len(content))
	for _, block := range content {
		if block.Type != "image" {
			out = append(out, block)
			continue
		}
		if strings.TrimSpace(block.Data) != "" {
			out = append(out, block)
			continue
		}
		path, err := s.attachmentPath(workspaceID, agentSessionID, block.AttachmentID, block.MimeType)
		if err != nil {
			return nil, err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read agent prompt attachment: %w", err)
		}
		out = append(out, PromptContentBlock{
			Type:         "image",
			MimeType:     block.MimeType,
			Data:         base64.StdEncoding.EncodeToString(data),
			AttachmentID: block.AttachmentID,
			Name:         block.Name,
		})
	}
	return out, nil
}

func (s PromptAttachmentStore) ReadAttachment(workspaceID, agentSessionID, attachmentID string) (PromptAttachment, error) {
	path, mimeType, err := s.findAttachmentPath(workspaceID, agentSessionID, attachmentID)
	if err != nil {
		return PromptAttachment{}, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return PromptAttachment{}, ErrSessionNotFound
		}
		return PromptAttachment{}, fmt.Errorf("read agent prompt attachment: %w", err)
	}
	return PromptAttachment{
		AttachmentID: strings.TrimSpace(attachmentID),
		MimeType:     mimeType,
		Data:         base64.StdEncoding.EncodeToString(data),
	}, nil
}

func (s PromptAttachmentStore) LocalPath(workspaceID, agentSessionID, attachmentID, mimeType string) (string, error) {
	mimeType = strings.TrimSpace(mimeType)
	if mimeType == "" {
		path, _, err := s.findAttachmentPath(workspaceID, agentSessionID, attachmentID)
		return path, err
	}
	path, err := s.attachmentPath(workspaceID, agentSessionID, attachmentID, mimeType)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", ErrSessionNotFound
		}
		return "", fmt.Errorf("stat agent prompt attachment: %w", err)
	}
	return path, nil
}

func (s PromptAttachmentStore) findAttachmentPath(workspaceID, agentSessionID, attachmentID string) (string, string, error) {
	for _, candidate := range []struct {
		mimeType string
		ext      string
	}{
		{mimeType: "image/png", ext: ".png"},
		{mimeType: "image/jpeg", ext: ".jpg"},
		{mimeType: "image/webp", ext: ".webp"},
	} {
		path, err := s.attachmentPath(workspaceID, agentSessionID, attachmentID, candidate.mimeType)
		if err != nil {
			return "", "", err
		}
		if _, err := os.Stat(path); err == nil {
			return path, candidate.mimeType, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", "", fmt.Errorf("stat agent prompt attachment: %w", err)
		}
	}
	return "", "", ErrSessionNotFound
}

func (s PromptAttachmentStore) attachmentPath(workspaceID, agentSessionID, attachmentID, mimeType string) (string, error) {
	root := filepath.Clean(strings.TrimSpace(s.RootDir))
	if root == "" || root == "." || root == string(filepath.Separator) {
		return "", errors.New("agent prompt attachment root is not configured")
	}
	if strings.TrimSpace(workspaceID) == "" || strings.TrimSpace(agentSessionID) == "" || strings.TrimSpace(attachmentID) == "" {
		return "", ErrInvalidArgument
	}
	ext := promptImageExtension(mimeType)
	if ext == "" {
		return "", ErrInvalidArgument
	}
	sessionSegment, err := sanitizePathSegment(agentSessionID)
	if err != nil {
		return "", err
	}
	attachmentSegment, err := sanitizePathSegment(attachmentID)
	if err != nil {
		return "", err
	}
	base := filepath.Join(root, "agent", "attachments")
	path := filepath.Join(base, sessionSegment, attachmentSegment+ext)
	rel, err := filepath.Rel(base, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", ErrInvalidArgument
	}
	return path, nil
}

func promptImageExtension(mimeType string) string {
	switch strings.TrimSpace(mimeType) {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	default:
		return ""
	}
}

func sanitizePathSegment(value string) (string, error) {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, string(filepath.Separator), "_")
	value = strings.ReplaceAll(value, "/", "_")
	value = strings.ReplaceAll(value, "\\", "_")
	if value == "" || value == "." || value == ".." {
		return "", ErrInvalidArgument
	}
	return value, nil
}

func promptImageOnlyDisplayText(content []PromptContentBlock) string {
	count := 0
	for _, block := range content {
		if block.Type == "image" {
			count++
		}
	}
	if count == 1 {
		return "[Image]"
	}
	if count > 1 {
		return "[Images]"
	}
	return ""
}
