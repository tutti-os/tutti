package agentextension

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strings"
)

const (
	manifestSchema = "tutti.agent.manifest.v2"
	maxFiles       = 256
)

func extractPackage(data []byte, destination string) error {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return err
	}
	if len(reader.File) == 0 || len(reader.File) > maxFiles {
		return errors.New("agent extension archive file count is invalid")
	}
	var total uint64
	for _, file := range reader.File {
		name := filepath.Clean(filepath.FromSlash(file.Name))
		if name == "." || filepath.IsAbs(name) || name == ".." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
			return errors.New("agent extension archive contains unsafe path")
		}
		if file.Mode()&os.ModeSymlink != 0 {
			return errors.New("agent extension archive contains symlink")
		}
		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(filepath.Join(destination, name), 0o700); err != nil {
				return err
			}
			continue
		}
		if internalPackageRecord(name) {
			return errors.New("agent extension archive contains reserved authority record")
		}
		if file.Mode()&0o111 != 0 {
			return errors.New("agent extension archive contains executable")
		}
		if !allowedExtension(filepath.Ext(name)) {
			return fmt.Errorf("agent extension archive contains forbidden file type %s", name)
		}
		total += file.UncompressedSize64
		if total > maxArtifact {
			return errors.New("agent extension archive exceeds expanded size limit")
		}
		path := filepath.Join(destination, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		source, err := file.Open()
		if err != nil {
			return err
		}
		target, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			source.Close()
			return err
		}
		_, copyErr := io.Copy(target, source)
		closeErr := target.Close()
		source.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}

func validateInstalledPackage(root, key, version string) (Manifest, error) {
	var manifest Manifest
	if err := readJSON(filepath.Join(root, "tutti.agent.json"), &manifest); err != nil {
		return Manifest{}, err
	}
	if manifest.SchemaVersion != manifestSchema || manifest.AgentKey != key || manifest.Version != version || strings.TrimSpace(manifest.Name) == "" {
		return Manifest{}, errors.New("installed extension manifest identity is invalid")
	}
	if manifest.Icon.Type != "asset" || !safeRelativePath(manifest.Icon.Src) || manifest.Runtime.Kind != "standard-acp" || !safeRelativePath(manifest.Profiles.Discovery) {
		return Manifest{}, errors.New("installed extension manifest contract is invalid")
	}
	if manifest.HeroImage.Src != "" && (manifest.HeroImage.Type != "asset" || !safeRelativePath(manifest.HeroImage.Src)) {
		return Manifest{}, errors.New("installed extension hero image is invalid")
	}
	if manifest.MaskIcon.Src != "" && (manifest.MaskIcon.Type != "asset" || !safeRelativePath(manifest.MaskIcon.Src)) {
		return Manifest{}, errors.New("installed extension mask icon is invalid")
	}
	if err := validateRuntimeContract(manifest); err != nil {
		return Manifest{}, err
	}
	if !safeRelativePath(manifest.LocalizationInfo.DefaultFile) {
		return Manifest{}, errors.New("installed extension default locale is invalid")
	}
	for _, referenced := range []string{manifest.Icon.Src, manifest.MaskIcon.Src, manifest.HeroImage.Src, manifest.LocalizationInfo.DefaultFile, manifest.Profiles.Discovery, manifest.Profiles.Tools, manifest.Profiles.Capabilities, manifest.Profiles.Composer, manifest.Profiles.Events} {
		if referenced == "" {
			continue
		}
		if !safeRelativePath(referenced) {
			return Manifest{}, errors.New("installed extension reference is unsafe")
		}
		info, err := os.Stat(filepath.Join(root, filepath.FromSlash(referenced)))
		if err != nil || !info.Mode().IsRegular() {
			return Manifest{}, fmt.Errorf("installed extension reference is missing: %s", referenced)
		}
	}
	for _, locale := range manifest.LocalizationInfo.AdditionalLocales {
		if !safeRelativePath(locale.File) {
			return Manifest{}, errors.New("installed extension locale reference is unsafe")
		}
		info, err := os.Stat(filepath.Join(root, filepath.FromSlash(locale.File)))
		if err != nil || !info.Mode().IsRegular() {
			return Manifest{}, fmt.Errorf("installed extension locale is missing: %s", locale.File)
		}
	}
	if err := validateInstalledProfiles(root, manifest); err != nil {
		return Manifest{}, fmt.Errorf("validate installed extension profiles: %w", err)
	}
	return manifest, nil
}

func packageAssetDataURL(root, relative string) (string, error) {
	if !safeRelativePath(relative) {
		return "", errors.New("unsafe extension asset path")
	}
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
	if err != nil {
		return "", err
	}
	if len(data) > 256<<10 {
		return "", errors.New("extension presentation asset exceeds size limit")
	}
	if strings.EqualFold(filepath.Ext(relative), ".svg") {
		lower := strings.ToLower(string(data))
		for _, forbidden := range []string{"<script", "<foreignobject", "javascript:", "href=\"http", "href='http", "url(http", " onload=", " onclick="} {
			if strings.Contains(lower, forbidden) {
				return "", errors.New("extension SVG contains unsafe active or remote content")
			}
		}
	}
	contentType := mime.TypeByExtension(strings.ToLower(filepath.Ext(relative)))
	if contentType == "" {
		return "", errors.New("unsupported extension presentation asset type")
	}
	return "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func allowedExtension(ext string) bool {
	switch strings.ToLower(ext) {
	case ".json", ".md", ".svg", ".png", ".jpg", ".jpeg", ".webp":
		return true
	}
	return false
}

func safeRelativePath(value string) bool {
	if strings.Contains(value, "\\") || strings.ContainsRune(value, 0) {
		return false
	}
	clean := filepath.Clean(filepath.FromSlash(value))
	return value != "" && !filepath.IsAbs(clean) && clean != ".." && !strings.HasPrefix(clean, ".."+string(filepath.Separator))
}
