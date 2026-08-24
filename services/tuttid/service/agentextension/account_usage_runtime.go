package agentextension

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const managedAccountUsageActivationSchema = "tutti.agent.account-usage-runtime.v1"

type managedAccountUsageActivation struct {
	SchemaVersion           string                       `json:"schemaVersion"`
	RuntimeIdentity         string                       `json:"runtimeIdentity"`
	Package                 string                       `json:"package"`
	ScriptRelativePath      string                       `json:"scriptRelativePath"`
	ScriptFingerprint       runtimeExecutableFingerprint `json:"scriptFingerprint"`
	ExtensionInstallationID string                       `json:"extensionInstallationId"`
	InstalledAt             time.Time                    `json:"installedAt"`
}

func (m *Manager) localAccountUsageExecutable(installation Installation) string {
	if m == nil || !installation.HasLocalPackageProvenance() {
		return ""
	}
	for _, source := range m.Sources {
		if source.Key == installation.AgentKey && sourceUsesLocalPackage(source) {
			return strings.TrimSpace(source.LocalAccountUsageExecutable)
		}
	}
	return ""
}

func (m *Manager) resolvedLocalAccountUsageRuntimeBinding(
	script string,
	profile *AccountUsageProfile,
) (*AccountUsageRuntimeBinding, error) {
	return m.resolvedLocalAccountUsageRuntimeBindingContext(context.Background(), script, profile)
}

func (m *Manager) resolvedLocalAccountUsageRuntimeBindingContext(
	ctx context.Context,
	script string,
	profile *AccountUsageProfile,
) (*AccountUsageRuntimeBinding, error) {
	script = strings.TrimSpace(script)
	if script == "" || !filepath.IsAbs(script) || profile == nil {
		return nil, errors.New("local account usage companion is invalid")
	}
	scriptFingerprint, err := fingerprintAccountUsageScriptContext(ctx, script)
	if err != nil {
		return nil, fmt.Errorf("fingerprint local account usage companion: %w", err)
	}
	return m.accountUsageNodeBinding(ctx, script, scriptFingerprint, profile)
}

func (s *SetupService) installAccountUsageCompanion(ctx context.Context, installation Installation, plan InstallPlan) error {
	companion := plan.AccountUsage
	if companion == nil {
		return nil
	}
	profile, err := loadAccountUsageProfile(installation)
	if err != nil {
		return err
	}
	if profile == nil || profile.Runtime.Kind != "node-script" ||
		profile.Runtime.Package != companion.Package ||
		accountUsageEffectiveRunner(installation.Manifest.Runtime.Install.Runner, profile) != companion.Runner {
		return errors.New("account usage companion install contract changed")
	}
	base := filepath.Join(s.Plans.Manager.RuntimeInstallDir, ".account-usage")
	if err := validateManagedRuntimeRoot(companion.InstallRoot, base, installation.AgentKey, companion.RuntimeIdentity); err != nil {
		return err
	}
	workspace, err := openManagedRuntimeWorkspaceForInstall(base, installation.AgentKey, true)
	if err != nil {
		return err
	}
	defer workspace.Close()
	if present, presentErr := managedRuntimeEntryPresent(workspace, companion.RuntimeIdentity); presentErr == nil && present {
		if _, resolveErr := s.Plans.Manager.resolveInstalledAccountUsageRuntimeBindingContext(ctx, installation, profile); resolveErr == nil {
			return nil
		}
	}
	staging, err := workspace.createTemp(".account-usage-install-")
	if err != nil {
		return err
	}
	defer staging.Close()
	stagingName := staging.name
	defer func() { _ = workspace.remove(stagingName) }()
	scratch, err := workspace.createTemp(".account-usage-work-")
	if err != nil {
		return err
	}
	defer scratch.Close()
	scratchName := scratch.name
	defer func() { _ = workspace.remove(scratchName) }()

	installCtx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()
	command := replaceInstallRoot(companion.InstallCommand, companion.InstallRoot, staging.path)
	if len(command) == 0 || command[0] != companion.Runner {
		return errors.New("account usage companion runner identity changed")
	}
	runner := s.Runner
	if runner == nil {
		runner = localInstallCommandRunner{}
	}
	if err := runner.Run(installCtx, command, scratch.path, cleanInstallEnvironment(scratch.path)); err != nil {
		return err
	}
	stagedScript, err := stagedRuntimePath(companion.InstallRoot, companion.Script, staging.path)
	if err != nil {
		return err
	}
	realScript, err := filepath.EvalSymlinks(stagedScript)
	if err != nil {
		return err
	}
	realStaging, err := filepath.EvalSymlinks(staging.path)
	if err != nil || !pathWithin(realScript, realStaging) {
		return errors.New("account usage companion script escapes staging root")
	}
	fingerprint, err := fingerprintAccountUsageScript(realScript)
	if err != nil {
		return err
	}
	relativeScript, err := filepath.Rel(realStaging, realScript)
	if err != nil || relativeScript == "." || !pathWithin(realScript, realStaging) {
		return errors.New("account usage companion script path is invalid")
	}
	activation := managedAccountUsageActivation{
		SchemaVersion:   managedAccountUsageActivationSchema,
		RuntimeIdentity: companion.RuntimeIdentity, Package: companion.Package,
		ScriptRelativePath: filepath.ToSlash(relativeScript), ScriptFingerprint: fingerprint,
		ExtensionInstallationID: installation.ID, InstalledAt: time.Now().UTC(),
	}
	if err := staging.writeJSONAtomic("activation.json", activation); err != nil {
		return err
	}
	return activateAccountUsageCompanion(workspace, staging, companion, activation)
}

func activateAccountUsageCompanion(
	workspace *managedRuntimeWorkspace,
	staging *managedRuntimeDirectory,
	plan *AccountUsageInstall,
	activation managedAccountUsageActivation,
) error {
	if workspace == nil || staging == nil || plan == nil || staging.workspace != workspace {
		return errors.New("account usage activation workspace is invalid")
	}
	backupName := plan.RuntimeIdentity + ".previous"
	_ = workspace.remove(backupName)
	hadPrevious := false
	if present, err := managedRuntimeEntryPresent(workspace, plan.RuntimeIdentity); err != nil {
		return err
	} else if present {
		if err := workspace.rename(plan.RuntimeIdentity, backupName); err != nil {
			return err
		}
		hadPrevious = true
	}
	rollback := func() {
		_ = workspace.remove(plan.RuntimeIdentity)
		if hadPrevious {
			_ = workspace.rename(backupName, plan.RuntimeIdentity)
		}
	}
	if err := staging.Close(); err != nil {
		rollback()
		return err
	}
	if err := workspace.rename(staging.name, plan.RuntimeIdentity); err != nil {
		rollback()
		return err
	}
	staging.name = plan.RuntimeIdentity
	staging.path = plan.InstallRoot
	promoted, err := workspace.openDirectoryName(plan.RuntimeIdentity)
	if err != nil {
		rollback()
		return err
	}
	staging.file = promoted.file
	promoted.file = nil
	script := filepath.Join(plan.InstallRoot, filepath.FromSlash(activation.ScriptRelativePath))
	fingerprint, err := fingerprintAccountUsageScript(script)
	if err != nil || fingerprint != activation.ScriptFingerprint {
		_ = staging.Close()
		rollback()
		if err != nil {
			return fmt.Errorf("account usage companion changed during activation: %w", err)
		}
		return errors.New("account usage companion fingerprint changed during activation")
	}
	_ = workspace.remove(backupName)
	return nil
}

func (m *Manager) resolveInstalledAccountUsageRuntimeBindingContext(
	ctx context.Context,
	installation Installation,
	profile *AccountUsageProfile,
) (*AccountUsageRuntimeBinding, error) {
	identity, err := accountUsageRuntimeIdentity(installation, profile, runtimePlatform())
	if err != nil {
		return nil, err
	}
	base := filepath.Join(m.RuntimeInstallDir, ".account-usage")
	root := managedRuntimeRoot(base, installation.AgentKey, identity)
	if _, err := os.Lstat(root); err != nil {
		return nil, err
	}
	workspace, err := openManagedRuntimeWorkspaceForInstall(base, installation.AgentKey, true)
	if err != nil {
		return nil, err
	}
	defer workspace.Close()
	active, err := workspace.openDirectoryName(identity)
	if err != nil {
		return nil, err
	}
	defer active.Close()
	var activation managedAccountUsageActivation
	if err := active.readJSON("activation.json", &activation); err != nil {
		return nil, err
	}
	if activation.SchemaVersion != managedAccountUsageActivationSchema ||
		activation.RuntimeIdentity != identity || activation.Package != profile.Runtime.Package {
		return nil, fmt.Errorf("%w: account usage activation identity is invalid", ErrManagedRuntimeIntegrity)
	}
	relativeScript := filepath.Clean(filepath.FromSlash(activation.ScriptRelativePath))
	if relativeScript == "." || filepath.IsAbs(relativeScript) || !pathWithin(filepath.Join(root, relativeScript), root) {
		return nil, fmt.Errorf("%w: account usage companion script escapes install root", ErrManagedRuntimeIntegrity)
	}
	declaredScript := filepath.Clean(resolveAccountUsageScript(profile.Runtime.Script, root))
	realDeclaredScript, err := filepath.EvalSymlinks(declaredScript)
	if err != nil || filepath.Clean(realDeclaredScript) != filepath.Join(root, relativeScript) {
		return nil, fmt.Errorf("%w: account usage companion script does not match the signed profile", ErrManagedRuntimeIntegrity)
	}
	scriptFile, err := active.openFile(relativeScript, os.O_RDONLY)
	if err != nil {
		return nil, fmt.Errorf("%w: account usage companion script is not an ordinary file", ErrManagedRuntimeIntegrity)
	}
	fingerprint, fingerprintErr := fingerprintAccountUsageScriptFileContext(ctx, scriptFile)
	closeErr := scriptFile.Close()
	if fingerprintErr != nil || closeErr != nil || fingerprint != activation.ScriptFingerprint || fingerprint.SHA256 == "" {
		return nil, fmt.Errorf("%w: account usage companion script fingerprint changed", ErrManagedRuntimeIntegrity)
	}
	return m.accountUsageNodeBinding(ctx, filepath.Join(root, relativeScript), fingerprint, profile)
}

func (m *Manager) accountUsageNodeBinding(
	ctx context.Context,
	script string,
	fingerprint runtimeExecutableFingerprint,
	profile *AccountUsageProfile,
) (*AccountUsageRuntimeBinding, error) {
	nodePath := strings.TrimSpace(environmentValue(m.RuntimeResolver.Env(nil), "TUTTI_APP_NODE"))
	if nodePath == "" {
		names := []string{"node"}
		if runtime.GOOS == "windows" {
			names = []string{"node.exe", "node"}
		}
		nodePath = m.RuntimeResolver.ResolveBinary(names, nil)
	}
	if nodePath == "" || !filepath.IsAbs(nodePath) {
		return nil, errors.New("node interpreter is unavailable")
	}
	realNode, err := filepath.EvalSymlinks(nodePath)
	if err != nil {
		return nil, err
	}
	nodeIdentity, err := m.accountUsageNodeIdentity(ctx, realNode)
	if err != nil {
		return nil, fmt.Errorf("fingerprint Node interpreter: %w", err)
	}
	return &AccountUsageRuntimeBinding{
		NodePath: realNode, ScriptPath: script, Args: append([]string(nil), profile.Runtime.Args...),
		Timeout:      time.Duration(profile.Runtime.TimeoutMS) * time.Millisecond,
		NodeIdentity: nodeIdentity, ScriptIdentity: executableIdentity(fingerprint),
	}, nil
}

func resolveAccountUsageScript(declaration, root string) string {
	return strings.NewReplacer("${installRoot}", root).Replace(declaration)
}

func fingerprintAccountUsageScript(path string) (runtimeExecutableFingerprint, error) {
	return fingerprintAccountUsageScriptContext(context.Background(), path)
}

func fingerprintAccountUsageScriptContext(ctx context.Context, path string) (runtimeExecutableFingerprint, error) {
	if err := ctx.Err(); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return runtimeExecutableFingerprint{}, errors.New("account usage companion script is not an ordinary file")
	}
	file, err := os.Open(path)
	if err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	defer file.Close()
	fileInfo, err := file.Stat()
	if err != nil || !os.SameFile(info, fileInfo) {
		return runtimeExecutableFingerprint{}, errors.New("account usage companion script changed while opening")
	}
	return fingerprintAccountUsageScriptFileContext(ctx, file)
}

func fingerprintAccountUsageScriptFileContext(ctx context.Context, file *os.File) (runtimeExecutableFingerprint, error) {
	if file == nil {
		return runtimeExecutableFingerprint{}, errors.New("account usage companion script descriptor is required")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 16<<20 {
		return runtimeExecutableFingerprint{}, errors.New("account usage companion script is invalid")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, &contextCheckingReader{ctx: ctx, reader: file}); err != nil {
		return runtimeExecutableFingerprint{}, err
	}
	return runtimeExecutableFingerprint{SHA256: hex.EncodeToString(hash.Sum(nil)), Size: info.Size()}, nil
}

func stagedRuntimePath(installRoot, installedPath, staging string) (string, error) {
	relative, err := filepath.Rel(filepath.Clean(installRoot), filepath.Clean(installedPath))
	if err != nil || relative == "." || relative == ".." || !pathWithin(installedPath, installRoot) {
		return "", errors.New("runtime path escapes install root")
	}
	result := filepath.Join(staging, relative)
	if !pathWithin(result, staging) {
		return "", errors.New("staged runtime path escapes staging root")
	}
	return result, nil
}
