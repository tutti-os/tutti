package workspacefiles

import (
	"fmt"
	"path"
	"path/filepath"
	"strings"
)

func NormalizeLogicalRoot(root string) LogicalPath {
	root = strings.TrimSpace(root)
	if root == "" {
		root = DefaultLogicalRoot
	}
	normalized := path.Clean("/" + strings.TrimPrefix(strings.ReplaceAll(root, "\\", "/"), "/"))
	if normalized == "." || normalized == "/" {
		return DefaultLogicalRoot
	}
	return LogicalPath(normalized)
}

func NormalizeLogicalPath(value string) (LogicalPath, error) {
	return NormalizeLogicalPathWithinRoot(value, DefaultLogicalRoot)
}

func NormalizeLogicalPathWithinRoot(value string, root string) (LogicalPath, error) {
	logicalRoot := NormalizeLogicalRoot(root)
	raw := strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	if raw == "" {
		return logicalRoot, nil
	}

	var candidate string
	if strings.HasPrefix(raw, "/") || isWindowsAbsolutePath(raw) {
		// Logical paths always use a leading slash. Windows drive-qualified
		// paths (for example, C:/Users/demo) are absolute too, but their
		// drive letter means they do not start with one. Prefixing the
		// normalized value keeps the logical representation stable as
		// /C:/Users/demo while preserving the physical drive in WorkspaceRoot.
		candidate = path.Clean("/" + strings.TrimPrefix(raw, "/"))
	} else {
		candidate = path.Clean(path.Join(logicalRoot.String(), raw))
	}
	if candidate == "." {
		candidate = logicalRoot.String()
	}
	if !strings.HasPrefix(candidate, "/") {
		candidate = "/" + candidate
	}
	if logicalRoot.String() != "/" && candidate != logicalRoot.String() && !strings.HasPrefix(candidate, logicalRoot.String()+"/") {
		return "", fmt.Errorf("%w: %q", ErrPathEscapesRoot, value)
	}
	return LogicalPath(candidate), nil
}

func isWindowsAbsolutePath(value string) bool {
	if len(value) < 3 {
		return false
	}
	letter := value[0]
	return ((letter >= 'a' && letter <= 'z') ||
		(letter >= 'A' && letter <= 'Z')) &&
		value[1] == ':' && (value[2] == '/' || value[2] == '\\')
}

func IsLogicalRoot(value LogicalPath, root string) bool {
	return value.String() == NormalizeLogicalRoot(root).String()
}

func LogicalPathBase(value LogicalPath) string {
	normalized, err := NormalizeLogicalPath(value.String())
	if err != nil {
		return ""
	}
	if normalized.String() == DefaultLogicalRoot {
		return "workspace"
	}
	return path.Base(normalized.String())
}

func LogicalPathDir(value LogicalPath) LogicalPath {
	normalized, err := NormalizeLogicalPath(value.String())
	if err != nil {
		return DefaultLogicalRoot
	}
	if normalized.String() == DefaultLogicalRoot {
		return DefaultLogicalRoot
	}
	dir := path.Dir(normalized.String())
	if dir == "." || dir == "/" {
		return DefaultLogicalRoot
	}
	return LogicalPath(dir)
}

func LogicalRelativePath(value LogicalPath, root string) (string, error) {
	logicalRoot := NormalizeLogicalRoot(root)
	normalized, err := NormalizeLogicalPathWithinRoot(value.String(), logicalRoot.String())
	if err != nil {
		return "", err
	}
	if normalized == logicalRoot {
		return "", nil
	}
	if logicalRoot.String() == "/" {
		return strings.TrimPrefix(normalized.String(), "/"), nil
	}
	return strings.TrimPrefix(normalized.String(), logicalRoot.String()+"/"), nil
}

func JoinPhysicalPath(root WorkspaceRoot, value LogicalPath) (string, error) {
	physicalRoot := strings.TrimSpace(root.PhysicalRoot)
	if physicalRoot == "" {
		return "", fmt.Errorf("%w: physical root is empty", ErrInvalidPath)
	}
	relative, err := LogicalRelativePath(value, root.LogicalRoot)
	if err != nil {
		return "", err
	}
	candidate := filepath.Join(physicalRoot, filepath.FromSlash(relative))
	if !IsPhysicalPathWithinRoot(physicalRoot, candidate) {
		return "", fmt.Errorf("%w: %q", ErrPathEscapesRoot, candidate)
	}
	return candidate, nil
}

func IsPhysicalPathWithinRoot(rootPath string, candidatePath string) bool {
	rootAbs, err := filepath.Abs(strings.TrimSpace(rootPath))
	if err != nil {
		return false
	}
	candidateAbs, err := filepath.Abs(strings.TrimSpace(candidatePath))
	if err != nil {
		return false
	}
	if rootAbs == candidateAbs {
		return true
	}
	rel, err := filepath.Rel(rootAbs, candidateAbs)
	if err != nil {
		return false
	}
	return rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func EvaluatePhysicalPathWithinRoot(rootPath string, candidatePath string) (string, error) {
	resolvedRoot, err := filepath.EvalSymlinks(rootPath)
	if err != nil {
		return "", err
	}
	resolvedCandidate, err := filepath.EvalSymlinks(candidatePath)
	if err != nil {
		return "", err
	}
	if !IsPhysicalPathWithinRoot(resolvedRoot, resolvedCandidate) {
		return "", fmt.Errorf("%w: %q", ErrPathEscapesRoot, candidatePath)
	}
	return resolvedCandidate, nil
}
