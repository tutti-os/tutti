package workspace

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"mime"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

const (
	AppManifestSchemaVersionV1 = "tutti.app.manifest.v1"
	MaxAppPackageIconBytes     = 5 * 1024 * 1024
	MaxAppPackageLocaleBytes   = 256 * 1024
	MinAppWindowWidth          = 280
	MinAppWindowHeight         = 160
	MaxAppWindowWidth          = 1600
	MaxAppWindowHeight         = 1200
)

type AppManifest struct {
	SchemaVersion    string                       `json:"schemaVersion"`
	AppID            string                       `json:"appId"`
	Version          string                       `json:"version"`
	Name             string                       `json:"name"`
	Description      string                       `json:"description"`
	Icon             AppManifestIcon              `json:"icon"`
	Runtime          AppManifestRuntime           `json:"runtime"`
	CLI              *AppManifestCLI              `json:"cli,omitempty"`
	References       *AppManifestReferences       `json:"references,omitempty"`
	Window           *AppManifestWindow           `json:"window,omitempty"`
	Launch           *AppManifestLaunch           `json:"launch,omitempty"`
	Author           *AppManifestAuthor           `json:"author,omitempty"`
	Authors          []AppManifestAuthor          `json:"authors,omitempty"`
	Source           *AppManifestSource           `json:"source,omitempty"`
	Tags             []string                     `json:"tags,omitempty"`
	LocalizationInfo *AppManifestLocalizationInfo `json:"localizationInfo,omitempty"`
}

type AppManifestIcon struct {
	Type string `json:"type"`
	Src  string `json:"src"`
}

type AppManifestRuntime struct {
	Bootstrap       string `json:"bootstrap"`
	HealthcheckPath string `json:"healthcheckPath"`
	Profile         string `json:"profile,omitempty"`
}

type AppManifestCLI struct {
	Manifest string `json:"manifest"`
}

type AppManifestReferences struct {
	ListEndpoint   string `json:"listEndpoint"`
	SearchEndpoint string `json:"searchEndpoint,omitempty"`
}

type AppManifestWindow struct {
	MinimizeBehavior string `json:"minimizeBehavior,omitempty"`
	MinWidth         *int   `json:"minWidth,omitempty"`
	MinHeight        *int   `json:"minHeight,omitempty"`
}

type AppManifestLaunch struct {
	Mode string `json:"mode"`
}

type AppManifestAuthor struct {
	Name      string `json:"name"`
	URL       string `json:"url,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
}

type AppManifestSource struct {
	Type string `json:"type"`
	URL  string `json:"url"`
}

type AppManifestLocalizationInfo struct {
	DefaultLocale     string                        `json:"defaultLocale"`
	AdditionalLocales []AppManifestLocalizationFile `json:"additionalLocales,omitempty"`
}

type AppManifestLocalizationFile struct {
	Locale string `json:"locale"`
	File   string `json:"file"`
}

type AppManifestLocalization struct {
	Locale      string   `json:"locale"`
	Name        string   `json:"name,omitempty"`
	Description string   `json:"description,omitempty"`
	Tags        []string `json:"tags,omitempty"`
}

type AppPackage struct {
	AppID                string
	Version              string
	PackageDir           string
	Manifest             AppManifest
	ManifestJSON         string
	CatalogLocalizations []AppManifestLocalization
	Source               AppPackageSource
	FactoryJobID         string
	CreatedInWorkspaceID string
	CreatedAtUnixMs      int64
}

func (p AppPackage) DisplayName() string {
	if strings.TrimSpace(p.Manifest.Name) != "" {
		return p.Manifest.Name
	}
	return p.AppID
}

func (p AppPackage) Description() string {
	return p.Manifest.Description
}

func (p AppPackage) ReferenceListSupported() bool {
	return p.Manifest.References != nil && strings.TrimSpace(p.Manifest.References.ListEndpoint) != ""
}

func (p AppPackage) ReferenceSearchSupported() bool {
	return p.Manifest.References != nil && strings.TrimSpace(p.Manifest.References.SearchEndpoint) != ""
}

func (p AppPackage) MinimizeBehavior() string {
	if p.Manifest.Window == nil {
		return "keep-mounted"
	}
	minimizeBehavior := strings.TrimSpace(p.Manifest.Window.MinimizeBehavior)
	if minimizeBehavior == "hibernate" {
		return "hibernate"
	}
	return "keep-mounted"
}

func (p AppPackage) WindowMinWidth() *int {
	if p.Manifest.Window == nil || p.Manifest.Window.MinWidth == nil {
		return nil
	}
	value := *p.Manifest.Window.MinWidth
	return &value
}

func (p AppPackage) WindowMinHeight() *int {
	if p.Manifest.Window == nil || p.Manifest.Window.MinHeight == nil {
		return nil
	}
	value := *p.Manifest.Window.MinHeight
	return &value
}

func (p AppPackage) IconDataURL() *string {
	src := strings.TrimSpace(p.Manifest.Icon.Src)
	if src == "" || !isRelativePackagePath(src) || strings.TrimSpace(p.PackageDir) == "" {
		return nil
	}

	iconPath := filepath.Join(p.PackageDir, filepath.FromSlash(src))
	data, err := os.ReadFile(iconPath)
	if err != nil || len(data) == 0 || len(data) > MaxAppPackageIconBytes {
		return nil
	}

	mimeType := mime.TypeByExtension(strings.ToLower(filepath.Ext(iconPath)))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	dataURL := "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data)
	return &dataURL
}

func (p AppPackage) Localizations() []AppManifestLocalization {
	if p.Manifest.LocalizationInfo == nil || strings.TrimSpace(p.PackageDir) == "" {
		return append([]AppManifestLocalization(nil), p.CatalogLocalizations...)
	}

	localizations := make([]AppManifestLocalization, 0, len(p.Manifest.LocalizationInfo.AdditionalLocales))
	for _, entry := range p.Manifest.LocalizationInfo.AdditionalLocales {
		locale, file := strings.TrimSpace(entry.Locale), strings.TrimSpace(entry.File)
		if locale == "" || !isRelativePackagePath(file) {
			continue
		}
		localization, ok := p.readLocalizationFile(locale, file)
		if ok {
			localizations = append(localizations, localization)
		}
	}
	if len(localizations) == 0 {
		return append([]AppManifestLocalization(nil), p.CatalogLocalizations...)
	}
	return localizations
}

func (p AppPackage) readLocalizationFile(locale string, file string) (AppManifestLocalization, bool) {
	filePath := filepath.Join(p.PackageDir, filepath.FromSlash(file))
	data, err := os.ReadFile(filePath)
	if err != nil || len(data) == 0 || len(data) > MaxAppPackageLocaleBytes {
		return AppManifestLocalization{}, false
	}

	var document struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Tags        []string `json:"tags"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		return AppManifestLocalization{}, false
	}

	localization := AppManifestLocalization{
		Locale:      locale,
		Name:        strings.TrimSpace(document.Name),
		Description: strings.TrimSpace(document.Description),
	}
	for _, tag := range document.Tags {
		if trimmed := strings.TrimSpace(tag); trimmed != "" {
			localization.Tags = append(localization.Tags, trimmed)
		}
	}
	if localization.Name == "" && localization.Description == "" && len(localization.Tags) == 0 {
		return AppManifestLocalization{}, false
	}
	return localization, true
}

type AppInstallation struct {
	WorkspaceID string
	AppID       string
	Enabled     bool
}

type AppRuntimeStatus string

const (
	AppRuntimeStatusIdle                    AppRuntimeStatus = "idle"
	AppRuntimeStatusPreparing               AppRuntimeStatus = "preparing"
	AppRuntimeStatusStarting                AppRuntimeStatus = "starting"
	AppRuntimeStatusRunning                 AppRuntimeStatus = "running"
	AppRuntimeStatusInstalledPendingRestart AppRuntimeStatus = "installed_pending_restart"
	AppRuntimeStatusFailed                  AppRuntimeStatus = "failed"
	AppRuntimeStatusStopping                AppRuntimeStatus = "stopping"
)

type AppRuntimeState struct {
	Status          AppRuntimeStatus
	LaunchURL       *string
	Port            *int
	FailureReason   *string
	LastError       *string
	StartedAtUnixMs *int64
	UpdatedAtUnixMs *int64
	PackageDir      string
}

type AppInstallUserPhase string

const (
	AppInstallUserPhaseDownloading AppInstallUserPhase = "downloading"
	AppInstallUserPhaseInstalling  AppInstallUserPhase = "installing"
	AppInstallUserPhaseStarting    AppInstallUserPhase = "starting"
)

type AppInstallProgress struct {
	UserPhase       AppInstallUserPhase
	OverallPercent  float64
	DownloadedBytes *int64
	TotalBytes      *int64
	Indeterminate   bool
	UpdatedAtUnixMs int64
}

type AppCLIStatus string

const (
	AppCLIStatusNone    AppCLIStatus = "none"
	AppCLIStatusPending AppCLIStatus = "pending"
	AppCLIStatusActive  AppCLIStatus = "active"
	AppCLIStatusWarning AppCLIStatus = "warning"
	AppCLIStatusError   AppCLIStatus = "error"
)

type AppCLIIssue struct {
	Code    string
	Message string
	Path    string
}

type AppCLIState struct {
	Status AppCLIStatus
	Scope  string
	Active bool
	Issues []AppCLIIssue
}

type WorkspaceApp struct {
	Package          AppPackage
	Installation     *AppInstallation
	IconURL          *string
	AvailableVersion *string
	AvailableIconURL *string
	UpdateAvailable  bool
	Runtime          AppRuntimeState
	InstallProgress  *AppInstallProgress
	CLI              AppCLIState
	References       AppReferencesState
	StateRevision    int64
}

type AppReferencesState struct {
	ListSupported   bool
	SearchSupported bool
}

type AppReferenceListInput struct {
	ParentGroupID string
	FilterText    string
	Limit         int
	Cursor        string
	Kinds         []AppReferenceKind
	TimeRange     *AppReferenceListTimeRange
}

type AppReferenceSearchInput struct {
	Query string
	Limit int
	// Filters 为已选「文件类型筛选分类」id(全局统一口径),透传到 app 的 searchEndpoint。
	Filters   []string
	Cursor    string
	Kinds     []AppReferenceKind
	TimeRange *AppReferenceListTimeRange
}

type AppReferenceListTimeRange struct {
	FromMs *int64
	ToMs   *int64
}

type AppReferenceListResult struct {
	Items      []AppReferenceListItem
	NextCursor *string
}

type AppReferenceListItem interface {
	AppReferenceListItemType() AppReferenceListItemType
}

type AppReferenceListItemType string

const (
	AppReferenceListItemTypeGroup     AppReferenceListItemType = "group"
	AppReferenceListItemTypeReference AppReferenceListItemType = "reference"
)

type AppReferenceGroup struct {
	ID             string
	DisplayName    string
	Description    string
	ReferenceCount int
}

func (AppReferenceGroup) AppReferenceListItemType() AppReferenceListItemType {
	return AppReferenceListItemTypeGroup
}

type AppReferenceListReferenceItem struct {
	Reference AppReference
}

func (AppReferenceListReferenceItem) AppReferenceListItemType() AppReferenceListItemType {
	return AppReferenceListItemTypeReference
}

type AppReferenceKind string

const (
	AppReferenceKindFile AppReferenceKind = "file"
)

type AppReference interface {
	AppReferenceKind() AppReferenceKind
}

type AppFileReference struct {
	DisplayName string
	Description string
	Path        string
	SizeBytes   *int64
	MtimeMs     *int64
	MimeType    string
	Score       *float64
	// ParentGroupLabel is the group/project this file belongs to, used as the
	// search-result context subtitle. Empty when the app does not provide it.
	ParentGroupLabel string
}

func (AppFileReference) AppReferenceKind() AppReferenceKind {
	return AppReferenceKindFile
}

type AppCatalogLoadStatus string

const (
	AppCatalogLoadStatusDisabled AppCatalogLoadStatus = "disabled"
	AppCatalogLoadStatusLoading  AppCatalogLoadStatus = "loading"
	AppCatalogLoadStatusReady    AppCatalogLoadStatus = "ready"
	AppCatalogLoadStatusFailed   AppCatalogLoadStatus = "failed"
)

type AppCatalogLoadState struct {
	Status          AppCatalogLoadStatus
	LastError       *string
	UpdatedAtUnixMs *int64
}

func (app WorkspaceApp) ResolvedIconURL() *string {
	if app.IconURL != nil {
		return app.IconURL
	}
	return app.Package.IconDataURL()
}

type AppPackageSource string

const (
	AppPackageSourceBuiltin   AppPackageSource = "builtin"
	AppPackageSourceGenerated AppPackageSource = "generated"
	AppPackageSourceImported  AppPackageSource = "imported"
	AppPackageSourceLocalDev  AppPackageSource = "local-dev"
)

type AppFactoryJobStatus string

const (
	AppFactoryJobStatusQueued     AppFactoryJobStatus = "queued"
	AppFactoryJobStatusGenerating AppFactoryJobStatus = "generating"
	AppFactoryJobStatusPreparing  AppFactoryJobStatus = "preparing"
	AppFactoryJobStatusValidating AppFactoryJobStatus = "validating"
	AppFactoryJobStatusReady      AppFactoryJobStatus = "ready"
	AppFactoryJobStatusPublished  AppFactoryJobStatus = "published"
	AppFactoryJobStatusFailed     AppFactoryJobStatus = "failed"
	AppFactoryJobStatusCanceled   AppFactoryJobStatus = "canceled"
)

type AppFactoryValidationResult struct {
	OK        bool     `json:"ok"`
	Errors    []string `json:"errors,omitempty"`
	CheckedAt int64    `json:"checkedAtUnixMs"`
}

type AppFactoryJob struct {
	JobID                string
	WorkspaceID          string
	Status               AppFactoryJobStatus
	Prompt               string
	AppID                string
	DisplayName          string
	Description          string
	AgentTargetID        string
	Provider             string
	Model                string
	ReasoningEffort      string
	AgentSessionID       string
	DraftDir             string
	RuntimeDir           string
	DataDir              string
	LogDir               string
	PackageDir           string
	ValidationResultJSON string
	FailureReason        string
	PublishedVersion     string
	CreatedAtUnixMs      int64
	UpdatedAtUnixMs      int64
}

func ParseAppManifestJSON(data []byte) (AppManifest, string, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return AppManifest{}, "", fmt.Errorf("parse app manifest json: %w", err)
	}
	if err := validateAppManifestReferencesJSON(raw); err != nil {
		return AppManifest{}, "", err
	}

	var manifest AppManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return AppManifest{}, "", fmt.Errorf("parse app manifest json: %w", err)
	}
	if err := ValidateAppManifest(manifest); err != nil {
		return AppManifest{}, "", err
	}
	normalized, err := json.Marshal(manifest)
	if err != nil {
		return AppManifest{}, "", fmt.Errorf("serialize app manifest json: %w", err)
	}
	return manifest, string(normalized), nil
}

func validateAppManifestReferencesJSON(raw map[string]json.RawMessage) error {
	referencesRaw, ok := raw["references"]
	if !ok {
		return nil
	}
	if strings.TrimSpace(string(referencesRaw)) == "null" {
		return errors.New("app manifest references must be an object when provided")
	}
	var references map[string]json.RawMessage
	if err := json.Unmarshal(referencesRaw, &references); err != nil {
		return errors.New("app manifest references must be an object when provided")
	}
	for key := range references {
		if key != "listEndpoint" && key != "searchEndpoint" {
			return fmt.Errorf("app manifest references.%s is unsupported", key)
		}
	}
	return nil
}

func ReadAppManifestFile(path string) (AppManifest, string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return AppManifest{}, "", fmt.Errorf("read app manifest: %w", err)
	}
	return ParseAppManifestJSON(data)
}

func ValidateAppManifest(manifest AppManifest) error {
	if !isSupportedAppManifestSchemaVersion(strings.TrimSpace(manifest.SchemaVersion)) {
		return fmt.Errorf("unsupported app manifest schema version %q", manifest.SchemaVersion)
	}
	if strings.TrimSpace(manifest.AppID) == "" {
		return errors.New("app manifest appId is required")
	}
	if strings.TrimSpace(manifest.Version) == "" {
		return errors.New("app manifest version is required")
	}
	if strings.TrimSpace(manifest.Name) == "" {
		return errors.New("app manifest name is required")
	}
	if strings.TrimSpace(manifest.Runtime.Bootstrap) == "" {
		return errors.New("app manifest runtime.bootstrap is required")
	}
	bootstrap := strings.TrimSpace(manifest.Runtime.Bootstrap)
	if strings.HasPrefix(bootstrap, "/") || strings.Contains(bootstrap, "..") {
		return errors.New("app manifest runtime.bootstrap must be a relative package path")
	}
	if strings.TrimSpace(manifest.Runtime.HealthcheckPath) == "" {
		return errors.New("app manifest runtime.healthcheckPath is required")
	}
	if !strings.HasPrefix(manifest.Runtime.HealthcheckPath, "/") {
		return errors.New("app manifest runtime.healthcheckPath must start with /")
	}
	if profile := strings.TrimSpace(manifest.Runtime.Profile); profile != "" && profile != "node-static" && profile != "standalone" {
		return errors.New("app manifest runtime.profile must be node-static or standalone when set")
	}
	if manifest.Window != nil {
		minimizeBehavior := strings.TrimSpace(manifest.Window.MinimizeBehavior)
		if minimizeBehavior != "" && minimizeBehavior != "keep-mounted" && minimizeBehavior != "hibernate" {
			return errors.New("app manifest window.minimizeBehavior must be keep-mounted or hibernate")
		}
		if err := validateAppManifestWindowSize("minWidth", manifest.Window.MinWidth, MinAppWindowWidth, MaxAppWindowWidth); err != nil {
			return err
		}
		if err := validateAppManifestWindowSize("minHeight", manifest.Window.MinHeight, MinAppWindowHeight, MaxAppWindowHeight); err != nil {
			return err
		}
	}
	if manifest.CLI != nil {
		cliManifest := strings.TrimSpace(manifest.CLI.Manifest)
		if cliManifest == "" {
			return errors.New("app manifest cli.manifest is required when cli is provided")
		}
		if !isRelativePackagePath(cliManifest) {
			return errors.New("app manifest cli.manifest must be a relative package path")
		}
	}
	if manifest.References != nil {
		listEndpoint := strings.TrimSpace(manifest.References.ListEndpoint)
		if listEndpoint == "" {
			return errors.New("app manifest references.listEndpoint is required when references is provided")
		}
		if !isRelativeURLPath(listEndpoint) {
			return errors.New("app manifest references.listEndpoint must be a relative URL path without query or fragment")
		}
		if searchEndpoint := strings.TrimSpace(manifest.References.SearchEndpoint); searchEndpoint != "" {
			if !isRelativeURLPath(searchEndpoint) {
				return errors.New("app manifest references.searchEndpoint must be a relative URL path without query or fragment")
			}
		}
	}
	if manifest.Author != nil && strings.TrimSpace(manifest.Author.Name) == "" {
		return errors.New("app manifest author.name is required when author is provided")
	}
	if len(manifest.Authors) > 0 {
		for index, author := range manifest.Authors {
			if strings.TrimSpace(author.Name) == "" {
				return fmt.Errorf("app manifest authors[%d].name is required", index)
			}
		}
	}
	if manifest.Source != nil {
		if strings.TrimSpace(manifest.Source.Type) != "github" {
			return errors.New("app manifest source.type must be github when source is provided")
		}
		if strings.TrimSpace(manifest.Source.URL) == "" {
			return errors.New("app manifest source.url is required when source is provided")
		}
	}
	if manifest.Launch != nil {
		mode := strings.TrimSpace(manifest.Launch.Mode)
		if mode != "workspace-open" {
			return errors.New("app manifest launch.mode must be workspace-open when launch is provided")
		}
	}
	for _, tag := range manifest.Tags {
		if strings.TrimSpace(tag) == "" {
			return errors.New("app manifest tags must be non-empty strings")
		}
	}
	return validateAppManifestLocalizationInfo(manifest.LocalizationInfo)
}

func isSupportedAppManifestSchemaVersion(schemaVersion string) bool {
	return schemaVersion == AppManifestSchemaVersionV1
}

func validateAppManifestWindowSize(field string, value *int, minimum int, maximum int) error {
	if value == nil {
		return nil
	}
	if *value < minimum || *value > maximum {
		return fmt.Errorf("app manifest window.%s must be between %d and %d", field, minimum, maximum)
	}
	return nil
}

func validateAppManifestLocalizationInfo(info *AppManifestLocalizationInfo) error {
	if info == nil {
		return nil
	}
	defaultLocale := strings.TrimSpace(info.DefaultLocale)
	if defaultLocale == "" {
		return errors.New("app manifest localizationInfo.defaultLocale is required")
	}
	seenLocales := map[string]struct{}{
		strings.ToLower(defaultLocale): {},
	}
	for _, entry := range info.AdditionalLocales {
		locale := strings.TrimSpace(entry.Locale)
		if locale == "" {
			return errors.New("app manifest localizationInfo.additionalLocales.locale is required")
		}
		localeKey := strings.ToLower(locale)
		if _, ok := seenLocales[localeKey]; ok {
			return fmt.Errorf("app manifest localizationInfo locale %q is duplicated", locale)
		}
		seenLocales[localeKey] = struct{}{}

		file := strings.TrimSpace(entry.File)
		if file == "" {
			return errors.New("app manifest localizationInfo.additionalLocales.file is required")
		}
		if !isRelativePackagePath(file) {
			return errors.New("app manifest localizationInfo.additionalLocales.file must be a relative package path")
		}
	}
	return nil
}

func isRelativePackagePath(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || filepath.IsAbs(trimmed) || strings.HasPrefix(trimmed, `\`) {
		return false
	}
	for _, part := range strings.FieldsFunc(trimmed, func(char rune) bool {
		return char == '/' || char == '\\'
	}) {
		if part == ".." {
			return false
		}
	}
	return true
}

func isRelativeURLPath(value string) bool {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" || !strings.HasPrefix(trimmed, "/") || strings.HasPrefix(trimmed, "//") || strings.Contains(trimmed, "\x00") {
		return false
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return false
	}
	return parsed.Scheme == "" && parsed.Host == "" && parsed.RawQuery == "" && parsed.Fragment == "" && parsed.Path == trimmed
}
