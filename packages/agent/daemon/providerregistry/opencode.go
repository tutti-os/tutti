package providerregistry

const (
	OpenCodeProviderID = "opencode"
	OpenCodeTargetID   = "local:opencode"
)

func openCodeDescriptor() ProviderDescriptor {
	return ProviderDescriptor{
		Identity: IdentityDescriptor{
			ID:          OpenCodeProviderID,
			DisplayName: "OpenCode",
			IconKey:     "opencode",
			LocaleKey:   "agentHost.agentGui.conversationFilterOpenCode",
			Aliases:     []string{"open-code", "open code", "opencode-ai", "opencode_ai"},
		},
		Runtime: RuntimeDescriptor{
			Kind:                RuntimeKindStandardACP,
			Name:                "opencode-acp",
			Command:             []string{"opencode", "acp"},
			AuthRequiredMessage: "OpenCode ACP requires authentication; run `opencode auth login` on the host, then retry this session.",
			StandardACP: StandardACPRuntimeDescriptor{
				PermissionModes: []RuntimePermissionModeDescriptor{
					{InputID: "", RuntimeID: "build"},
					{InputID: "build", RuntimeID: "build"},
					{InputID: "plan", RuntimeID: "plan"},
				},
				SettingsEnvironment: RuntimeSettingsEnvironmentDescriptor{
					Variable: "OPENCODE_CONFIG_CONTENT",
					JSONFields: []RuntimeSettingsJSONFieldDescriptor{
						{Setting: RuntimeSettingFieldModel, JSONKey: "model"},
					},
				},
				DeriveCapabilitiesFromCommands: []string{CapabilityCompact, CapabilityReview},
			},
		},
		Status: StatusDescriptor{
			Kind:                   StatusKindOpenCodeCLI,
			AuthOutputParserKind:   AuthOutputParserKindOpenCode,
			AuthMarkerParserKind:   AuthMarkerParserKindFileExists,
			AuthCommandRunnerKind:  AuthCommandRunnerKindGeneric,
			StaticSpecResolverKind: StaticSpecResolverKindGeneric,
			BinaryNames:            []string{"opencode"},
			AuthStatusCommand:      []string{"auth", "list"},
			AuthMarkerPaths:        []string{"~/.local/share/opencode/auth.json"},
			CustomConfigEnvVars: []string{
				"OPENCODE_CONFIG",
				"OPENCODE_CONFIG_DIR",
				"OPENCODE_CONFIG_CONTENT",
				"OPENCODE_PERMISSION",
			},
			Install: InstallerDescriptor{
				Kind:           InstallerKindOfficialScript,
				DisplayCommand: "curl -fsSL https://opencode.ai/install | bash",
				ScriptURL:      "https://opencode.ai/install",
				ScriptShell:    "bash",
			},
			LoginArgs: []string{"auth", "login"},
			AuthWatch: AuthWatchDescriptor{
				Sources: []AuthWatchSourceDescriptor{
					{PathEnvVars: []string{"OPENCODE_CONFIG"}},
					{
						RootCandidates: []AuthWatchRootCandidateDescriptor{
							{EnvVar: "OPENCODE_CONFIG_DIR"},
							{EnvVar: "XDG_CONFIG_HOME", Suffix: "opencode"},
						},
						DefaultRoot: "~/.config/opencode",
						Paths:       []string{"opencode.json", "config.json"},
					},
					{
						RootCandidates: []AuthWatchRootCandidateDescriptor{
							{EnvVar: "XDG_DATA_HOME", Suffix: "opencode"},
						},
						DefaultRoot: "~/.local/share/opencode",
						Paths:       []string{"auth.json"},
					},
				},
				ContentFingerprint: AuthWatchContentFingerprintFullFile,
			},
		},
		ComposerProfile: ComposerProfileDescriptor{
			ModelSelection:         true,
			ModelCatalog:           ModelCatalogKindOpenCodeCLI,
			ReasoningEffort:        true,
			ReasoningEffortValues:  []string{"low", "medium", "high", "xhigh"},
			ReasoningEffortOptions: ReasoningEffortOptionsStatic,
			DefaultReasoningEffort: "high",
			Capabilities: []string{
				CapabilityImageInput,
				CapabilityModelImageInputRequired,
				CapabilityPlanMode,
				CapabilityInterrupt,
			},
			ConfigOptionIDs: ComposerConfigOptionIDs{
				Model:     "model",
				Reasoning: "effort",
			},
			Skills: SkillDescriptor{Kind: SkillKindOpenCode, Invocation: SkillInvocationTextTrigger, ConfigDirSuffix: "opencode"},
			SlashCommandPolicy: SlashCommandPolicyDescriptor{
				FallbackCommands: []string{"compact", "goal", "review"},
				CommandEffects: []SlashCommandEffectDescriptor{
					{Command: "compact", Effect: SlashCommandEffectSubmitImmediate},
					{Command: "review", Effect: SlashCommandEffectShowReviewPicker},
					{Command: "goal", Effect: SlashCommandEffectActivateGoalMode},
					{Command: "plan", Effect: SlashCommandEffectTogglePlanMode},
				},
			},
		},
		Target: TargetDescriptor{
			ID:            OpenCodeTargetID,
			LaunchRefType: TargetLaunchRefTypeLocalCLI,
			Enabled:       true,
			SortOrder:     50,
		},
		Events: EventsDescriptor{
			Enabled:                 true,
			Aliases:                 []string{"open-code", "opencode-ai", "opencode_ai"},
			TurnLifecycleProjection: TurnLifecycleProjectionExplicit,
		},
		Sidecar: SidecarDescriptor{ExecutionEnvironment: SidecarExecutionEnvironmentLocalIPC},
		Desktop: DesktopIntegrationDescriptor{Managed: true, ManagedOrder: 5, StatusProbePriority: 5, VisibilityGate: DesktopVisibilityGateOpenCodePreview, DefaultProviderEligible: true, DefaultProviderPriority: 4},
	}
}
