package providerregistry

import canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"

const (
	ClaudeCodeProviderID = canonical.ClaudeCodeProviderID
	ClaudeCodeTargetID   = "local:claude-code"
)

func claudeCodeDescriptor() ProviderDescriptor {
	return ProviderDescriptor{
		Identity: canonicalProviderIdentity(ClaudeCodeProviderID),
		Runtime: RuntimeDescriptor{
			Kind: RuntimeKindClaudeSDK,
			Name: "claude-agent-sdk",
			Endpoint: RuntimeEndpointDescriptor{
				BaseURLEnvVars: []string{
					"ANTHROPIC_BASE_URL",
					"ANTHROPIC_API_BASE_URL",
				},
				ConfigKind:        EndpointConfigKindClaudeSettings,
				ModelPlanProtocol: ModelPlanProtocolAnthropic,
			},
		},
		Status: StatusDescriptor{
			Kind:                            StatusKindClaudeCLI,
			AuthOutputParserKind:            AuthOutputParserKindClaude,
			AuthMarkerParserKind:            AuthMarkerParserKindClaude,
			AuthCommandRunnerKind:           AuthCommandRunnerKindClaudeGate,
			StaticSpecResolverKind:          StaticSpecResolverKindGeneric,
			BinaryNames:                     []string{"claude"},
			AuthStatusCommand:               []string{"auth", "status"},
			AuthStatusCommandTimeoutSeconds: 600,
			AuthMarkerPaths:                 []string{"~/.claude.json", "~/.claude/auth.json"},
			APIEndpoints:                    []string{"https://api.anthropic.com/v1/messages"},
			CustomConfigEnvVars: []string{
				"ANTHROPIC_API_KEY",
				"ANTHROPIC_AUTH_TOKEN",
				"ANTHROPIC_BASE_URL",
				"ANTHROPIC_API_BASE_URL",
			},
			CredentialEnvVars: []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"},
			Install: InstallerDescriptor{
				Kind:           InstallerKindOfficialScript,
				DisplayCommand: "curl -fsSL https://claude.ai/install.sh | bash",
				ScriptURL:      "https://claude.ai/install.sh",
				ScriptShell:    "bash",
				FailureReasonMarkers: map[string][]string{
					"install_unavailable_in_region": {"app-unavailable-in-region", "app unavailable in region", "claude isn't available here", "claude isn&#x27;t available here", "claude isn&apos;t available here"},
				},
			},
			Update: UpdateDescriptor{
				Capability:        UpdateCapabilityUnsupported,
				UnsupportedReason: UpdateUnsupportedReasonOfficialScript,
			},
			LoginArgs: []string{"auth", "login"},
			AuthWatch: AuthWatchDescriptor{
				Sources: []AuthWatchSourceDescriptor{
					{
						RootCandidates: []AuthWatchRootCandidateDescriptor{{EnvVar: "CLAUDE_CONFIG_DIR"}},
						DefaultRoot:    "~/.claude",
						Paths:          []string{"settings.json", "auth.json", ".credentials.json"},
					},
					{DefaultRoot: "~", Paths: []string{".claude.json"}},
				},
				ContentFingerprint: AuthWatchContentFingerprintClaudeState,
			},
		},
		ComposerProfile: ComposerProfileDescriptor{
			ModelSelection: true,
			LiveModelDiscovery: LiveModelDiscoveryDescriptor{
				Kind:          LiveModelDiscoveryKindClaudeSDK,
				HiddenProbe:   true,
				AccountScoped: true,
			},
			ReasoningEffort:        true,
			ReasoningEffortValues:  []string{"low", "medium", "high", "xhigh"},
			ReasoningEffortOptions: ReasoningEffortOptionsStatic,
			DefaultReasoningEffort: "high",
			Speed:                  true,
			SpeedValues:            []string{"standard", "fast"},
			DefaultSpeed:           "standard",
			Capabilities: []string{
				"imageInput",
				"skills",
				"compact",
				"tokenUsage",
				"rateLimits",
				"planMode",
				CapabilityInterrupt,
				CapabilityActiveTurnGuidance,
				CapabilityModelSwitch,
				CapabilityModelPlanBinding,
				"permissionModeChangeDuringTurn",
			},
			PermissionConfigurable:  true,
			DefaultPermissionModeID: "default",
			PermissionModes: []PermissionModeDescriptor{
				{ID: "default", Semantic: "ask-before-write"},
				{ID: "acceptEdits", Semantic: "accept-edits"},
				{ID: "dontAsk", Semantic: "locked-down"},
				{ID: "bypassPermissions", Semantic: "full-access"},
			},
			ConfigOptionIDs: ComposerConfigOptionIDs{
				Model:      "model",
				Reasoning:  "effort",
				Speed:      "fast",
				Permission: "permission_mode",
			},
			Skills: SkillDescriptor{
				Kind:       SkillKindClaudeCode,
				Invocation: SkillInvocationTextTrigger,
			},
			SlashCommandPolicy: SlashCommandPolicyDescriptor{
				FallbackCommands:            []string{"compact", "status", "fast", "goal", "review"},
				CommandCatalogAuthoritative: true,
				CommandEffects: []SlashCommandEffectDescriptor{
					{Command: "compact", Effect: SlashCommandEffectSubmitImmediate},
					{Command: "context", Effect: SlashCommandEffectSubmitImmediate},
					{Command: "usage", Effect: SlashCommandEffectSubmitImmediate},
					{Command: "review", Effect: SlashCommandEffectShowReviewPicker},
					{Command: "goal", Effect: SlashCommandEffectActivateGoalMode},
					{Command: "plan", Effect: SlashCommandEffectTogglePlanMode},
					{Command: "status", Effect: SlashCommandEffectShowStatus},
					{Command: "fast", Effect: SlashCommandEffectToggleSpeed},
				},
			},
			Behavior: ComposerBehaviorDescriptor{
				ModelOptionsAuthoritative:           true,
				RefreshModelOptionsAfterSettings:    true,
				PrewarmDraftSession:                 true,
				PlanModeExclusiveWithPermissionMode: true,
			},
		},
		Target: TargetDescriptor{
			ID:            ClaudeCodeTargetID,
			LaunchRefType: TargetLaunchRefTypeLocalCLI,
			Enabled:       true,
			SortOrder:     20,
		},
		Events: EventsDescriptor{
			Enabled:                 true,
			Aliases:                 []string{"claude", "claude_code"},
			TurnLifecycleProjection: TurnLifecycleProjectionExplicit,
		},
		Sidecar: SidecarDescriptor{MentionRouting: SidecarMentionRoutingClaudeNamespaced, ExecutionEnvironment: SidecarExecutionEnvironmentClaudeIPC},
		Desktop: DesktopIntegrationDescriptor{Managed: true, ManagedOrder: 1, StatusProbePriority: 2, UsageProbeKind: DesktopUsageProbeClaudeCode, DeveloperLogs: true, DefaultProviderEligible: true, DefaultProviderPriority: 2},
		ExternalImport: ExternalImportDescriptor{
			Enabled:               true,
			RootEnvVar:            "CLAUDE_CONFIG_DIR",
			DefaultRoot:           "~/.claude",
			ScanDirectories:       []string{"projects"},
			SkipDirectoryPrefixes: []string{"agent-"},
			ParserKind:            ExternalImportParserKindClaudeJSONL,
			UserTextCleanerKind:   ExternalImportUserTextCleanerKindClaude,
		},
	}
}
