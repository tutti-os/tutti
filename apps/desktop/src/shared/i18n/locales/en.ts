export const en = {
  common: {
    cancel: "Cancel",
    close: "Close",
    defaultWorkspace: "default",
    loading: "Loading",
    neverOpened: "Never opened",
    ok: "OK",
    selectFolder: "Select folder",
    unknownError: "Unknown error",
    unreachable: "unreachable",
    workspace: "workspace",
    zipArchive: "ZIP Archive"
  },
  dashboard: {
    chooseWorkspaceTitle: "Choose a workspace",
    chooseWorkspaceDescription: "Choose a workspace to continue",
    createWorkspace: "Create workspace",
    creatingWorkspace: "Creating...",
    desktopFirstWorkflowDescription:
      "Renderer state stays presentation-only. Workspace lifecycle still flows through preload and tuttid.",
    desktopFirstWorkflowTitle: "Desktop-first workflow",
    emptyDescription: "Create a workspace and Tutti will open it right away.",
    emptyTitle: "No workspaces yet",
    launcherBadge: "workspaces",
    launcherDescription:
      "Open a workspace to continue where you left off. The workspaces page stays lightweight while the daemon keeps the durable state.",
    layeringDescription:
      "This workspaces page is intentionally narrow. The richer workspace surface still lives in the main window.",
    layeringTitle: "Ready for module layering",
    newWorkspacePrompt: "Need a new workspace instead? Create one here.",
    recentWorkspaces: "Recent workspaces",
    readyStatus: "{{count}} ready",
    restoreStateNote:
      "Workspaces are restored from local state, not re-derived in the renderer.",
    syncingStatus: "syncing",
    uiSystemNote:
      "The new UI system now owns tokens, icons, and shared primitives in one place.",
    welcomeDescription:
      "A local-first intelligent productivity platform that brings control and focus to your workflow.",
    welcomeTitle: "Welcome to Tutti",
    featureLocalTitle: "Local data storage",
    featureLocalDescription: "Privacy and safety stay under your control",
    featurePerformanceTitle: "Native performance",
    featurePerformanceDescription: "Fast response and a smoother workflow",
    featureExtensibleTitle: "Extensible ecosystem",
    featureExtensibleDescription:
      "Flexible integrations that can keep evolving",
    workspaceCountNote: "{{count}} recent workspaces are currently available"
  },
  updates: {
    availableTitle: "Update to New Version",
    badge: "update",
    checkingTitle: "Checking for updates",
    downloadAction: "Download update",
    downloadedTitle: "Ready to install",
    downloadingTitle: "Downloading {{percent}}",
    errorTitle: "Unable to check for updates",
    restartAction: "Restart & install",
    retryAction: "Retry"
  },
  desktop: {
    installGuard: {
      detail:
        "Tutti is running from the downloaded disk image. Move it to Applications before continuing so updates can install correctly.",
      failureDetail:
        "macOS could not move Tutti automatically. Drag {{appPath}} to Applications, then open Tutti from Applications.",
      failureMessage: "Move Tutti manually",
      message: "Move Tutti to Applications?",
      moveAction: "Move to Applications and Relaunch",
      quitAction: "Quit",
      showInFinderAction: "Show in Finder",
      title: "Install Tutti"
    },
    logsExport: {
      actionHint: "You can copy the agent prompt or open the exported folder.",
      agentPrompt: {
        archivePath: "Log archive: {{filePath}}",
        downloadDirectory: "Download directory: {{downloadDirectory}}",
        intro:
          "I just exported a Tutti log package. Please analyze what went wrong and help me fix it.",
        stepEvidence:
          "2. Explain the evidence behind your assessment and point to the relevant logs or files.",
        stepFixPlan: "3. Propose the smallest safe fix.",
        stepImplement:
          "4. If code or configuration changes are needed, implement the fix directly and explain what changed and why.",
        stepInspect:
          "1. First inspect runtime-context, export-summary, and the log files in the archive, then summarize the most likely problem.",
        stepsHeader: "Please handle it in this order:"
      },
      copyAgentPrompt: "Copy Agent Prompt",
      ok: "OK",
      openFolder: "Open Folder",
      savedTitle: "Logs saved",
      savedTo: "Saved {{count}} log files to:",
      title: "Export Logs"
    },
    menu: {
      checkForUpdates: "Check for Updates...",
      clearLogsCompletedDetail: "Cleared {{count}} log files.",
      clearLogsCompletedMessage: "Service logs have been cleared.",
      clearLogsFailed: "Unable to clear logs",
      clearLogsTitle: "Clear Logs",
      clearServiceLogs: "Clear Service Logs...",
      edit: "Edit",
      exportLogsFailed: "Unable to export logs",
      exportLogsTitle: "Export Logs",
      exportServiceLogs: "Export Service Logs...",
      file: "File",
      help: "Help",
      openPerfMonitor: "Open Perf Monitor DevTools",
      quit: "Quit Tutti",
      upToDateDetail: "Tutti {{version}} is currently the latest version.",
      upToDateMessage: "You're up to date!",
      view: "View",
      window: "Window"
    },
    quitShortcut: {
      confirmToastTitle: "Press Command + Q again to quit Tutti"
    }
  },
  workspace: {
    fallback: {
      loadingDescription:
        "Restoring your workspace context through the desktop bridge.",
      loadingTitle: "Loading workspace",
      missingContextDescription:
        "This window was opened without a workspace target. Open a workspace from the workspaces page.",
      missingContextTitle: "Missing workspace context",
      retryAction: "Try again",
      unavailableTitle: "Workspace unavailable"
    },
    chrome: {
      currentWorkspace: "Current workspace",
      deleteFailed: "Unable to delete workspace.",
      openWorkspaceFailed: "Unable to open workspace.",
      renameFailed: "Unable to rename workspace.",
      switchWorkspace: "Switch workspace",
      switchWorkspaceUnavailable: "Unable to load workspaces right now."
    },
    agentGui: {
      collapseConversationRail: "Hide sidebar",
      expandConversationRail: "Show sidebar",
      fallbackAgentLabel: "Agent",
      newConversation: "New session",
      openDetachedWindow: "Open in detached window",
      openNewWindow: "Open new window",
      openSessionUnavailableDescription:
        "This agent session no longer exists or cannot be opened.",
      openSessionUnavailableTitle: "Session unavailable",
      toolSidebar: {
        apps: "Apps",
        browser: "Browser",
        close: "Close",
        closeRightPanel: "Close right panel",
        expandPanel: "Expand panel",
        files: "Files",
        messages: "Messages",
        newTab: "New panel tab",
        openRightPanel: "Open right panel",
        resizeSidebar: "Resize tool sidebar",
        shrinkPanel: "Shrink panel",
        tasks: "Tasks",
        terminal: "Terminal",
        tool: "Tool",
        unavailable: "{{tool}} is not available in the Agent window yet."
      }
    },
    accountMenu: {
      title: "Tutti Agent",
      member: "Manage subscription",
      creditsBalance: "Credits",
      accountCenter: "Account settings",
      free: "Free",
      signIn: "Sign in",
      signOut: "Sign out",
      loading: "Loading",
      unavailable: "--",
      dataUnavailable: "Some account data is unavailable",
      rewardToastTitle: "New user credits",
      rewardToastCreditsUnit: "credits",
      rewardToastDescription: "Added to account balance",
      rewardToastClose: "Close credits reward notification"
    },
    agentEnv: {
      configTitle: "{{provider}} environment",
      wizardDescription:
        "Tutti will detect, install, and verify {{provider}} so it's ready to run.",
      configDescription:
        "{{provider}} is ready. Re-check it, or manage its version, sign-in, and install here.",
      phaseDetect: "Detect",
      phaseInstall: "Install & repair",
      phaseVerify: "Verify",
      detecting: "Checking your {{provider}} setup…",
      ready: "{{provider}} is ready to run.",
      busyInstalling: "Setting up {{provider}}…",
      busyVerifying: "Verifying {{provider}}…",
      actionDetect: "Re-check",
      redetectDisabledInstalling: "Can't re-check while setting up",
      redetectDisabledChecking: "Checking…",
      actionInstall: "Set up",
      actionRepair: "Repair install",
      actionUpgrade: "Upgrade",
      actionRelogin: "Sign in again",
      actionLogin: "Sign in",
      actionRetry: "Retry",
      stepCli: "{{provider}} CLI",
      stepVersion: "Supported version",
      stepAuth: "Signed in",
      stepRuntime: "Runtime ready",
      logToggle: "Setup log",
      registryLabel: "Registry",
      manualTitle: "Prefer to install it yourself?",
      manualDescription: "Run this command in a terminal, then re-check:",
      manualCopy: "Copy command",
      manualCopied: "Copied",
      fieldVersion: "Version",
      fieldPath: "CLI path",
      fieldTargetNode: "Target node",
      fieldAccount: "Signed-in account",
      fieldRegistry: "Registry preference",
      valueUnknown: "Unknown",
      valueNotInstalled: "Not installed",
      valueNotSignedIn: "Not signed in",
      valueSignedIn: "Signed in",
      registryPreferenceOfficial: "Official (npm)",
      registryPreferenceMirror: "Mirror",
      actionFailed: "That step failed. Check the log and try again.",
      providerUnsupported: "This agent has no managed environment setup yet.",
      stageDetect: "Detecting environment",
      stageNetwork: "Network check",
      stageDetectDone: "Environment detected",
      stageNetworkDone: "Network checked",
      stageInstallDone: "CLI installed",
      stageAdapterDone: "Adapter installed",
      stageLoginDone: "Signed in",
      stageLoginDoneApiBilling: "API billing configured",
      stageReadyDone: "Ready",
      networkCheckRegistry: "Install source",
      networkCheckApi: "Service API",
      networkCheckProxy: "Proxy",
      networkProxyNone: "Not configured (direct)",
      networkUnreachable: "Unreachable",
      stageInstall: "Install CLI",
      stageAdapter: "Install adapter",
      stageLogin: "Sign in",
      stageReady: "Ready",
      stageRetry: "Retry",
      setupRemaining:
        "Detection complete. Finish the steps below to enable {{provider}}.",
      stageProblemNetworkUnreachable: "Can't reach the network",
      stageProblemInstallMissing: "{{provider}} CLI not installed",
      stageProblemInstallOutdated: "{{provider}} CLI version unsupported",
      stageProblemInstallPlatformIncomplete:
        "{{provider}} platform package missing",
      stageInstallVersionRequirement: "{{current}} · requires ≥ {{required}}",
      stageAdapterVersionRequirement: "{{current}} · requires ≥ {{required}}",
      stageProblemAdapterMissing: "Adapter not installed",
      stageProblemAdapterMismatch: "Adapter version unsupported",
      stageProblemLoginMissing: "Not signed in",
      stageDoInstall: "Install",
      stageDoUpgrade: "Upgrade",
      stageDoRepair: "Repair install",
      stageDoLogin: "Sign in",
      stageDoRedetect: "Re-check",
      reportConsentTitle: "An environment problem was detected",
      reportConsentBody:
        "This sends fuller diagnostics (CLI paths, endpoints, proxy address, error details) to help us debug. Send it? You can change this anytime in Settings → General.",
      reportConsentAgree: "Agree & send",
      reportConsentCancel: "Not now"
    },
    referenceSources: {
      appSourceLabel: "Apps",
      issueSourceLabel: "Tasks",
      localSourceLabel: "Local",
      projectSourceLabel: "Projects",
      sidebarDesktop: "Desktop",
      sidebarDocuments: "Documents",
      sidebarDownloads: "Downloads",
      sidebarPersonal: "Home",
      sidebarRecent: "Recent"
    },
    agentMessageCenter: {
      openAria: "Open agent messages",
      promptConstraintHeader: "Constraint",
      promptInputHeader: "Input",
      promptQuestion: "Add a response for the agent.",
      promptTitle: "Waiting for input",
      title: "Agent messages",
      idleStatus: "Idle",
      outcomeNotificationCompletedBody:
        "The agent finished this run. Click to open the session.",
      outcomeNotificationCompletedStatus: "Completed",
      outcomeNotificationCompletedTitle: "{{title}} completed",
      outcomeNotificationFailedBody:
        "The agent run failed. Click to open the session.",
      outcomeNotificationFailedStatus: "Failed",
      outcomeNotificationFailedTitle: "{{title}} failed",
      waitingNotificationAction: "Review",
      waitingNotificationCommand: "Command",
      waitingNotificationConversationPrefix: "Session: ",
      waitingNotificationDescription:
        "{{title}} is waiting for your decision in Agent messages.",
      waitingNotificationPlanAcceptEdits: "Accept edits",
      waitingNotificationPlanAllowAll: "Allow all",
      waitingNotificationPlanAskFirst: "Ask for approval",
      waitingNotificationStatus: "Waiting",
      waitingNotificationTitle: "{{title}} needs your decision",
      runningCount: "{{count}} running",
      waitingCount: "{{count}} waiting"
    },
    feedbackGroup: {
      instruction: "Scan with WeChat",
      qrAlt: "Feedback group QR code",
      trigger: "Join Feedback Group",
      triggerAria: "Join feedback group"
    },
    externalImport: {
      archiveEmpty:
        "No supported conversations were found in this Claude export",
      archiveGroupLabel: "Claude chats",
      archiveOptionDescription:
        "Choose the ZIP file downloaded from Claude's data export",
      archiveOptionTitle: "Import Claude export data",
      archivePickFailed: "We couldn't open the Claude export file picker.",
      archiveResult:
        "Imported {{sessions}} conversations and {{messages}} messages from the Claude export",
      archiveScanFailed:
        "This ZIP could not be read as a supported Claude data export.",
      archiveScanning: "Reading Claude export conversations...",
      archiveSearchPlaceholder: "Search Claude conversations",
      archiveSelectionReady:
        "Claude export scan complete. {{count}} conversations are ready to review.",
      archiveSelectDescription:
        "Search and check the Claude conversations to import",
      back: "Back",
      chooseArchive: "Choose ZIP",
      description:
        "Import local Codex and Claude Code history or a Claude data export",
      done: "Done",
      empty: "No local Codex or Claude Code project history was found",
      errors: "Skipped items",
      import: "Import",
      importFailed: "We couldn't import external agent history right now.",
      importing: "Importing...",
      chatOptionDescription: "Recent 30 days · {{messages}} messages",
      chatOptionTitle: "Chat sessions ({{count}})",
      optionDescription: "Choose what to import from the scanned history",
      projectOptionDescription: "Use existing project folders",
      projectOptionTitle: "Projects ({{count}})",
      providerDescription: "Choose which local apps to scan",
      selectTitle: "Select conversations to import",
      selectDescription:
        "Search and check the projects and conversations to import",
      searchPlaceholder: "Search projects and conversations",
      selectAll: "Select all",
      selectedCount: "{{selected}} of {{total}} selected",
      noResults: "No conversations match your search",
      registerProjects: "Also register project folders",
      sessionMessages: "{{count}} messages",
      rangeLabel: "Time range",
      range7: "7 days",
      range30: "30 days",
      range90: "90 days",
      rangeAll: "All",
      selectSession: "Select {{title}}",
      selectProjectGroup: "Select all in {{label}}",
      promptDescription:
        "Tutti can import recent {{provider}} project conversations",
      promptImport: "Import",
      promptLater: "Later",
      promptTitle: "Import existing AI chats",
      result:
        "Imported {{sessions}} sessions and {{messages}} messages from {{projects}} projects",
      resultSkipped:
        "Skipped {{count}} conversations that were empty or unsupported",
      scan: "Scan",
      scanFailed: "We couldn't scan external agent history right now.",
      scanning: "Scanning local agent history...",
      selectProvider: "Select {{label}}",
      selectImportOption: "Select {{label}}",
      settingsAction: "Import",
      settingsDescription:
        "Bring local Codex and Claude Code history or Claude export conversations into Tutti",
      settingsLabel: "Import session history",
      title: "Import from AI apps"
    },
    analyticsDebug: {
      clear: "Clear",
      close: "Close analytics events",
      clientTimestamp: "client_ts: {{value}}",
      count: "{{count}} events",
      empty: "No analytics events yet",
      open: "Open analytics debug events",
      title: "Analytics events"
    },
    appCenter: {
      backToApps: "Back to apps",
      dockLabel: "Apps"
    },
    info: {
      idDescription: "Stable identifier for preload and daemon coordination.",
      idLabel: "Workspace ID",
      lastOpenedDescription: "Last time this workspace was restored or opened.",
      lastOpenedLabel: "Last opened",
      rendererRoleDescription:
        "Desktop UI remains presentation-only while tuttid owns durable state.",
      rendererRoleLabel: "Renderer role",
      rendererRoleValue: "UI shell"
    },
    meta: {
      daemonLabel: "daemon",
      platformLabel: "platform"
    },
    ready: {
      description:
        "This surface is intentionally light for now. We can layer real workspace modules here once the UI system is in place.",
      panelOne:
        "Navigation, rich content, and workspace-specific modules can now build on React, Tailwind, and the shared primitive layer instead of growing the old global stylesheet.",
      panelTwo:
        "The preload bridge and daemon APIs stay unchanged, so this migration only changes renderer composition and visual infrastructure.",
      title: "Workspace ready"
    },
    routeDescription:
      "Window routing still resolves from query params to keep the Electron shell simple.",
    runtime: {
      connectedDescription: "{{service}} is connected.",
      pendingDescription: "Health check pending.",
      statusDescription:
        "Health and shell metadata are now rendered through shared tokens and components.",
      statusTitle: "Runtime status"
    },
    wallpaper: {
      options: {
        custom: "Custom",
        default: "Default",
        dunes: "Starry dunes",
        ocean: "Ocean",
        orbit: "Earth at night",
        peaks: "Mountain night",
        sand: "Sand ripples",
        sky: "Sky",
        tutti: "Tutti"
      }
    },
    settings: {
      close: "Close settings",
      appearance: {
        dockPlacementDescription:
          "Controls where the workspace dock is anchored",
        dockPlacementLabel: "Dock layout",
        dockPlacementOptions: {
          bottom: "Bottom",
          left: "Left"
        },
        dockPlacementSaveFailed:
          "We couldn't update the dock layout right now.",
        dockIconStyleSaveFailed:
          "We couldn't update the Dock icon style right now.",
        minimizeAnimationDescription:
          "Controls the animation used when windows move into the dock",
        minimizeAnimationLabel: "Minimize animation",
        minimizeAnimationOptions: {
          genie: "Genie",
          off: "Off",
          scale: "Scale"
        },
        minimizeAnimationSaveFailed:
          "We couldn't update the minimize animation right now.",
        workbenchWindowSnappingDescription:
          "Enables edge and corner snapping plus keyboard window layouts",
        workbenchWindowSnappingLabel: "Window snapping",
        workbenchWindowSnappingSaveFailed:
          "We couldn't update window snapping right now.",
        workbenchWindowSnappingShortcutLabel: "Window snapping shortcut",
        workbenchWindowSnappingShortcutOptions: {
          off: "Off",
          commandArrows: "Command + Arrow keys",
          commandShiftArrows: "Command + Shift + Arrow keys"
        },
        themeDescription:
          "Controls window appearance and the color mode for information",
        themeLabel: "Appearance",
        themeOptions: {
          dark: "Dark",
          light: "Light",
          system: "Match system"
        },
        themeSaveFailed: "We couldn't switch the app appearance right now.",
        wallpaperDisplayModeLabel: "Display",
        wallpaperDisplayModeOptions: {
          center: "Center",
          fit: "Fit to Screen",
          original: "Original",
          stretch: "Stretch to Fill Screen"
        },
        wallpaperLabel: "Wallpaper",
        wallpaperRemove: "Remove custom wallpaper",
        wallpaperRemoveFailed:
          "We couldn't remove the custom wallpaper right now.",
        wallpaperUpload: "Upload wallpaper",
        wallpaperUploadError: "We couldn't use that image as a wallpaper.",
        wallpaperUploadErrorTooLarge:
          "That image is too large. Please choose a smaller file.",
        wallpaperUploadErrorType:
          "Unsupported image format. Please choose PNG, JPG, or WebP.",
        wallpaperUploading: "Uploading..."
      },
      general: {
        workspaceUiModeLabel: "Window interaction mode",
        workspaceUiModeOptions: {
          agentTitle: "Standalone Agent window mode",
          agentDescription:
            "Launch directly into a standalone Agent window, with files, tools, and more opening in the right-side panel",
          osTitle: "Immersive OS mode",
          osDescription:
            "Keep the immersive desktop experience, including multiple windows, the Dock, Launchpad, and more"
        },
        workspaceUiModeSaveFailed:
          "We couldn't update the startup interface right now.",
        defaultAgentProviderDescription:
          "Used when a task or workspace app does not specify a provider",
        defaultAgentProviderLabel: "Default provider",
        defaultAgentProviderSaveFailed:
          "We couldn't update the default provider right now.",
        agentConversationDetailModeLabel: "Work mode",
        agentConversationDetailModeOptions: {
          codingTitle: "For coding",
          codingDescription: "More technical responses and control.",
          generalTitle: "For everyday work",
          generalDescription: "Just as powerful, with less technical detail."
        },
        agentConversationDetailModeSaveFailed:
          "We couldn't update the work mode right now.",
        computerUseLabel: "Computer use",
        computerUseDescription:
          "Allows the agent to control your Mac desktop — take screenshots, click, type, and more.",
        computerUseInstallButton: "Install",
        computerUseInstalling: "Installing…",
        computerUseInstallSuccess: "cua-driver installed successfully.",
        computerUseInstallFailed: "Installation failed.",
        computerUseUninstallButton: "Remove",
        computerUseUninstalling: "Removing…",
        computerUseUninstallSuccess: "cua-driver removed.",
        computerUseUninstallFailed: "Removal failed.",
        computerUseProgressAria: "Computer use setup progress",
        computerUseManageButton: "Manage",
        computerUseGrantButton: "Grant Permissions",
        computerUseGrantAccessibilityButton: "Grant Accessibility",
        computerUseGrantScreenRecordingButton: "Grant Screen Recording",
        computerUseAuthorizedButton: "Authorized",
        computerUseGranting: "Waiting for permissions…",
        computerUseGrantingAccessibility: "Waiting for Accessibility…",
        computerUseGrantingScreenRecording: "Waiting for Screen Recording…",
        computerUseCheckingCaptureAvailability:
          "Checking screen capture availability…",
        computerUseStartAndCheckButton: "Start and Check",
        computerUseStartingCuaDriver: "Starting and checking…",
        computerUseGrantSuccess: "Permissions granted.",
        computerUseGrantFailed: "Could not grant permissions.",
        computerUseGrantAccessibilityInstruction:
          "Next: grant Accessibility. After approving it, continue with Screen Recording.",
        computerUseGrantScreenRecordingInstruction:
          "Next: grant Screen Recording.",
        computerUseScreenRecordingCaptureUnavailableInstruction:
          'Screen Recording is authorized, but CuaDriver needs a restart before it takes effect. Click "Restart to apply" to finish automatically.',
        computerUseGrantUnknownInstruction:
          "Authorization status cannot be confirmed. Click to let CuaDriver check again.",
        computerUseDriverDaemonNotRunningInstruction:
          'CuaDriver is not running, so its authorization status cannot be read. Click "Start" to launch CuaDriver and check automatically.',
        computerUseStartingCuaDriverInstruction:
          "Starting CuaDriver and checking authorization…",
        computerUseGrantTimedOutInstruction:
          "macOS did not show a permission confirmation. Open System Settings > Privacy & Security, enable CuaDriver permissions, then return to Tutti and check again.",
        computerUseGrantAccessibilityTimedOutInstruction:
          "macOS did not show the Accessibility confirmation. Open System Settings > Privacy & Security > Accessibility, enable CuaDriver, then return to Tutti and check again.",
        computerUseGrantScreenRecordingTimedOutInstruction:
          "macOS did not show the Screen Recording confirmation. Open System Settings > Privacy & Security > Screen & System Audio Recording, enable CuaDriver, then return to Tutti and check again.",
        computerUseGrantManualFallbackInstruction:
          "If no macOS permission prompt appeared, open {{settings}} and enable CuaDriver manually. Tutti will keep checking in the background.",
        computerUseOpenAccessibilitySettingsButton:
          "Open Accessibility Settings",
        computerUseOpenScreenRecordingSettingsButton:
          "Open Screen Recording Settings",
        computerUseOpenPrivacySettingsButton: "Open Privacy Settings",
        computerUseOpeningSettings: "Opening Settings…",
        computerUseOpenSettingsTooltip:
          "Open the matching macOS privacy settings page. Tutti will keep checking authorization while this panel is open.",
        computerUseOpenSettingsFailed: "Could not open System Settings.",
        computerUseAccessibilitySettingsOpenedInstruction:
          "Accessibility Settings is open. Enable CuaDriver there; Tutti will check automatically.",
        computerUseScreenRecordingSettingsOpenedInstruction:
          "Screen Recording Settings is open. Enable CuaDriver there; Tutti will check automatically.",
        computerUsePrivacySettingsOpenedInstruction:
          "Privacy Settings is open. Enable CuaDriver permissions there; Tutti will check automatically.",
        computerUseAuthorizedTooltip:
          "CuaDriver has Screen Recording and Accessibility permissions.",
        computerUsePermissionUnknownTooltip:
          "Authorization status cannot be confirmed. CuaDriver will check and guide authorization when clicked.",
        computerUsePermissionMissingTooltip:
          "Authorization needed: {{permissions}}.",
        computerUsePermissionAccessibility: "Accessibility",
        computerUsePermissionScreenRecording: "Screen Recording",
        computerUsePermissionListSeparator: ", ",
        computerUsePermissionDialogTitle: "Set up Computer Use",
        computerUsePermissionDialogDescription:
          "Tutti guides the flow, while macOS grants the permissions to CuaDriver.",
        computerUsePermissionDialogRelationshipTitle:
          "Why authorize CuaDriver?",
        computerUsePermissionDialogRelationshipBody:
          "Tutti uses CuaDriver to take screenshots, click, and type. macOS may ask you to authorize CuaDriver next; this is expected.",
        computerUsePermissionDialogIconHint:
          "After opening System Settings, find “CuaDriver” in the permission list and turn on its permission switch.",
        computerUsePermissionDialogRequiredTitle: "Required permissions",
        computerUsePermissionDialogActionTitle: "Current action",
        computerUsePermissionDialogActionReady:
          "CuaDriver has the permissions Tutti needs for computer control.",
        computerUsePermissionDialogAutoCheck:
          "Tutti is checking authorization automatically while this dialog stays open.",
        computerUsePermissionStatusGranted: "Effective",
        computerUsePermissionStatusMissing: "Needed",
        computerUsePermissionStatusUnknown: "Unknown",
        computerUsePermissionStatusCaptureUnavailable: "Granted, not effective",
        computerUseStatusInstalled: "Installed",
        computerUseStatusNotInstalled: "Not installed",
        computerUseStatusCheckAgain: "Check again",
        computerUseDriverRowLabel: "CuaDriver status",
        computerUseDriverStatusRunning: "Running",
        computerUseDriverStatusNotRunning: "Not running",
        computerUseStartDriverButton: "Start",
        computerUseRestartDriverButton: "Restart to apply",
        computerUseRestartingDriver: "Restarting CuaDriver…",
        computerUseRestartDriverFailed:
          "Restarting CuaDriver failed. Try again, or open the CuaDriver app manually and check again.",
        computerUseOpenPaneButton: "Open Settings",
        computerUseStatusCheckFailed:
          "Couldn't read permission status. Try again.",
        computerUseStatusRetryButton: "Retry",
        computerUseStatusUnchanged: "Checked again — no change.",
        computerUseLastCheckedAt: "Last checked {{time}}",
        computerUseDoneButton: "Done",
        computerUseWizardBack: "Back",
        computerUseWizardNext: "Next",
        computerUseWizardInstallBody:
          "Install CuaDriver — the local driver that performs screenshots, clicks, and typing. Installing requests no permissions.",
        computerUseWizardGrantInstruction:
          "After opening System Settings, find “CuaDriver” in the “{{permission}}” list and turn on its switch. Then click “Next”.",
        computerUseWizardScreenRecordingKillNote:
          "macOS may offer to reopen CuaDriver when you flip the switch — you can ignore it; the next step handles that automatically.",
        computerUseWizardVerifyBody:
          "Once you have granted both permissions, click “Check again” to confirm everything is ready (about 2 seconds). If an item still says “Needed”, click “Grant” next to it to finish that one.",
        computerUseWizardVerifyChecking: "Checking…",
        computerUseWizardGrantStepReturn: "Grant",
        computerUseWizardDoneBody:
          "Computer use is ready — the agent can now operate your desktop.",
        browserUseConnectionModeDescription:
          "Choose which browser the agent controls when it runs web tasks",
        browserUseConnectionModeLabel: "Browser connection",
        browserUseConnectionModeOptions: {
          autoConnect: "Reuse my Chrome",
          isolated: "Separate browser"
        },
        browserUseConnectionModeOptionHints: {
          autoConnect:
            "The agent drives the Chrome you already use on this computer. First enable remote debugging in Chrome at chrome://inspect/#remote-debugging. Changes apply the next time a browser session starts.",
          isolated:
            "Tutti launches a separate browser for the agent, leaving the Chrome you use day to day untouched. Changes apply the next time a browser session starts."
        },
        browserUseConnectionModeSaveFailed:
          "We couldn't update the browser connection setting right now.",
        agentDiagnosticsReportingLabel: "Targeted reporting",
        agentDiagnosticsReportingDescription:
          "When an environment problem is detected, send fuller diagnostics (CLI paths, endpoints, proxy address, error details) to help us debug. The account email is never sent.",
        languageDescription:
          "Applies to all open windows now and new windows after restart",
        languageLabel: "Language",
        languageOptions: {
          en: "English",
          zhCN: "Simplified Chinese"
        },
        localeSaveFailed: "We couldn't switch the app language right now.",
        preventSleepDescription: "Controls whether the system can enter sleep",
        preventSleepLabel: "Sleep prevention",
        preventSleepOptions: {
          always: "Always prevent sleep",
          never: "Allow computer sleep",
          whileAgentRunning: "Prevent sleep only while Agent runs"
        },
        preventSleepSaveFailed:
          "We couldn't update the sleep prevention setting right now.",
        updateChannelSaveFailed:
          "We couldn't update the release channel right now.",
        updatePolicySaveFailed: "We couldn't update the update mode right now.",
        versionLabel: "Desktop version"
      },
      nav: {
        about: "About",
        account: "Account",
        apps: "Apps",
        sectionsLabel: "Settings sections",
        appearance: "Appearance",
        agent: "Agent",
        developer: "Developer",
        general: "General",
        lab: "Lab"
      },
      about: {
        appName: "Tutti",
        developerModeEnabled: "Developer mode is now on",
        githubAction: "GitHub",
        versionLabel: "Version",
        websiteAction: "Website"
      },
      account: {
        description: "Sign in to use your Tutti account on this device.",
        login: "Sign in",
        logout: "Sign out",
        refresh: "Refresh",
        reopenLogin: "Open sign-in again",
        signedOutTitle: "Not signed in",
        signingIn: "Signing in...",
        signingOut: "Signing out..."
      },
      apps: {
        appCatalogChannelDescription:
          "Choose whether App Center shows released apps or test versions.",
        appCatalogChannelLabel: "App source",
        appCatalogChannelOptions: {
          production: "Released",
          staging: "Test"
        },
        appCatalogChannelSaveFailed: "We couldn't switch the app source.",
        managedModels: {
          apiKey: "API key",
          addModel: "Add",
          addProvider: "Add provider",
          baseUrl: "Base URL",
          collapse: "Collapse",
          customProvider: "Custom",
          delete: "Delete",
          deleteConfirm: "Delete this provider?",
          deleteFailed: "Couldn't delete — try again.",
          deleting: "Deleting...",
          description:
            "Bring your own model API keys for your workspace apps and agents to use",
          detectModels: "Fetch available models",
          detectingModels: "Fetching...",
          detectModelsEmpty: "No models found.",
          detectModelsFailed: "Couldn't fetch models — try again.",
          emptyDescription:
            "Click “Add provider” to connect Agnes, OpenAI, or Anthropic with your API key",
          emptyTitle: "No model providers yet",
          enabled: "Enable {{provider}}",
          expand: "Expand",
          getApiKey: "Get {{provider}} API key",
          hideApiKey: "Hide key",
          keyConfigured: "Key saved",
          keyMissing: "API key not set",
          keepExistingKey: "Leave blank to keep the saved key",
          loadFailed: "We couldn't load model providers.",
          modelId: "Model ID",
          modelIdPlaceholder: "model-id",
          models: "{{provider}} models",
          presetLabels: {
            agnes: "Agnes",
            anthropicClaude: "Anthropic (Claude)",
            deepseekAnthropic: "DeepSeek - Anthropic",
            deepseekOpenai: "DeepSeek - OpenAI",
            mimoAnthropic: "MiMo (Xiaomi) - Anthropic",
            mimoOpenai: "MiMo (Xiaomi) - OpenAI",
            minimaxAnthropic: "MiniMax - Anthropic",
            minimaxOpenai: "MiniMax - OpenAI",
            openaiOfficial: "OpenAI official"
          },
          removeModel: "Remove model",
          requiredFieldsMissing: "Fill in the API key and Base URL first.",
          quickFillProvider: "Choose a preset",
          save: "Save",
          saveFailed: "Couldn't save — try again.",
          saving: "Saving...",
          showApiKey: "Show key",
          test: "Test connection",
          testFailed: "Connection failed — check the key or URL.",
          testSucceeded: "Connection OK.",
          testing: "Testing...",
          modelCount: "{{count}} models",
          title: "Model providers"
        }
      },
      developer: {
        actionsLabel: "Actions",
        analyticsDebugDescription:
          "Shows a floating panel with local analytics events",
        analyticsDebugLabel: "Analytics event panel",
        clearConversationHistory: "Clear all conversations",
        clearConversationHistoryConfirm:
          "Delete all agent conversation history in this workspace? This cannot be undone.",
        clearLogs: "Clear logs",
        clearingConversationHistory: "Clearing...",
        clearingLogs: "Clearing...",
        conversationHistoryCleared: "Cleared {{count}} conversations.",
        conversationHistoryClearFailed:
          "We couldn't clear conversation history right now.",
        daemonLogLabel: "Daemon log",
        desktopLogLabel: "Desktop log",
        enableCursorAgentDescription:
          "Show the Cursor agent across the app. Off by default while Cursor support is in preview.",
        // i18n-check-ignore: Provider brand name.
        enableCursorAgentLabel: "Enable Cursor agent",
        enableCursorAgentSaveFailed:
          "We couldn't update the Cursor agent setting right now.",
        enableOpenCodeAgentDescription:
          "Show the OpenCode agent across the app. Off by default while OpenCode support is in preview.",
        // i18n-check-ignore: Provider brand name.
        enableOpenCodeAgentLabel: "Enable OpenCode agent",
        enableOpenCodeAgentSaveFailed:
          "We couldn't update the OpenCode agent setting right now.",
        exportLogs: "Export logs",
        exportLogsDialogTitle: "Export Logs",
        exportLogsFileType: "Zip Archive",
        exportingLogs: "Exporting...",
        fileDefaultOpenerActionLabel: "Default opener for .{{extension}}",
        fileDefaultOpenerExtensionLabel: "File extension",
        fileDefaultOpenerExtensionPlaceholder: "html",
        fileDefaultOpenerNewActionLabel: "New default opener",
        fileDefaultOpenerOptions: {
          appBrowser: "Built-in browser",
          defaultBrowser: "Default browser",
          fileViewer: "File viewer",
          system: "System default"
        },
        fileDefaultOpenersDescription:
          "Choose what opens first when a workspace file is activated by extension.",
        fileDefaultOpenersLabel: "Default file openers",
        labVisibilityDescription:
          "Shows experimental controls in a separate Settings tab.",
        labVisibilityLabel: "Show Lab tab",
        logMissing: "No file yet",
        logOpenFailed: "We couldn't open that log path right now.",
        logsCleared: "Cleared {{count}} log files ({{size}}).",
        logsClearFailed: "We couldn't clear local logs right now.",
        logsDirectoryLabel: "Log directory",
        logsExported: "Exported {{count}} log files to {{path}}.",
        logsExportFailed: "We couldn't export local logs right now.",
        logsLoadFailed: "We couldn't load local log details right now.",
        logsSizeLabel: "Log size",
        logsSummary: "{{count}} files, {{size}} total",
        logsTitle: "Logs",
        openDaemonLog: "Open daemon log",
        openDesktopLog: "Open desktop log",
        openLogsDirectory: "Open logs folder",
        addFileDefaultOpener: "Add",
        removeFileDefaultOpener: "Remove .{{extension}}",
        releaseChannelDescription:
          "Choose stable release updates, or opt in to preview builds for internal verification.",
        releaseChannelLabel: "Release channel",
        releaseChannelOptions: {
          rc: "Preview",
          stable: "Stable"
        },
        showAppDeveloperSourcesDescription:
          "Show each app's authors and GitHub source inside App Center cards.",
        showAppDeveloperSourcesLabel: "Show app authors and source",
        showAppDeveloperSourcesSaveFailed:
          "We couldn't update App Center source display.",
        tuttiAgentSwitchDescription:
          "Shows account and agent development controls.",
        tuttiAgentSwitchLabel: "Tutti Agent Switch",
        tuttiAgentSwitchSaveFailed:
          "We couldn't update Tutti Agent availability.",
        visibilityDescription:
          "Hide this panel from settings. Tap the version number in About seven times to bring it back",
        visibilityLabel: "Show developer panel"
      },
      lab: {
        clearShortcutLabel: "Clear {{label}}",
        newAgentConversationShortcutLabel: "New Agent conversation",
        newSameTypeWindowShortcutLabel: "New same-type window",
        preferencesSaveFailed: "We couldn't update Lab preferences.",
        shortcutUnbound: "Unbound",
        workbenchShortcutsDescription:
          "Enables configurable workbench shortcut actions.",
        workbenchShortcutsLabel: "Workbench shortcuts"
      },
      title: "Settings",
      trigger: "Settings"
    },
    workbenchDesktop: {
      closeGuard: {
        cancel: "Cancel",
        confirm: "Terminate terminal",
        description:
          "This terminal still has running work. Terminating it will stop the session.",
        title: "Terminate terminal?"
      },
      windowCloseGuard: {
        cancel: "Keep window open",
        confirm: "Close window",
        description:
          "This window still has running work. Closing it will dismiss the room while background work may continue.",
        title: "Close this window?"
      },
      windowControls: {
        close: "Close",
        maximize: "Maximize",
        minimize: "Minimize",
        restore: "Restore"
      },
      nodes: {
        agent: "Agent",
        appCenter: "Apps",
        appWebview: "Workspace app",
        browser: "Browser",
        files: "Files",
        imageFile: "Image file",
        issues: "Issues",
        textFile: "Text file",
        terminal: "Terminal"
      },
      filePreview: {
        loading: "Loading...",
        revert: "Revert",
        save: "Save",
        saved: "Saved",
        saveFailed: "Unable to save",
        saving: "Saving...",
        unsaved: "Unsaved changes",
        unsupportedFallback:
          "Preview is not supported yet. Opening with your local app."
      },
      filesLaunch: {
        openFailedDescription:
          "This session's original working directory could no longer be found on this computer.",
        openFailedTitle: "Couldn't open folder"
      },
      agentProviders: {
        checking: "Checking local CLI status...",
        comingSoon: "Coming soon",
        install: "Connect",
        installFailed: "Connection failed",
        installFailedDescription:
          "Unable to connect the local agent right now. Try again in a moment.",
        installFailedMissingRuntime:
          "The local agent executable could not be found. Check that it is installed correctly.",
        installFailedOutdatedLocalAgent:
          "An older local Agent was detected, but automatic upgrade failed.",
        installFailedTimedOut: "Connection timed out. Try again in a moment.",
        installUnavailableInRegion: "Claude isn't available in this region.",
        installRequired: "Connect the local agent to continue",
        installing: "Connecting",
        login: "Sign in",
        loginFailed: "Sign-in failed",
        loginRequired: "Sign in to the local CLI to use this agent",
        manageActionConnect: "Connect",
        manageActionLogin: "Sign in",
        manageActionOpeningLogin: "Opening...",
        manageActionUnavailableTooltip:
          "No setup action is available for this agent right now.",
        manageColumnAction: "Action",
        manageColumnAgent: "Agent",
        manageColumnConfig: "Configuration",
        manageColumnConnection: "Connection status",
        manageConfigDetected: "Local configuration detected",
        manageConfigMissing: "No local configuration detected",
        manageProviderClaudeCode: "Claude Code",
        manageProviderCodex: "Codex",
        manageProviderCursor: "Cursor",
        manageProviderHermes: "Hermes",
        manageProviderNexight: "Tutti Agent",
        manageProviderOpenClaw: "OpenClaw",
        manageProviderOpenCode: "Open Code",
        manageProviderTutti: "Tutti",
        manageProviderTuttiAgent: "Tutti Agent",
        manageStatusAuthRequired: "Sign-in required",
        manageStatusAvailable: "Available to connect",
        manageStatusChecking: "Checking",
        manageStatusConnected: "Connected",
        manageStatusUnknown: "Status unavailable",
        manageStatusUnsupported: "Updating in background",
        manageTitle: "Manage Agents",
        manageUnsupportedTooltip:
          "This agent is temporarily unavailable while local support updates.",
        refresh: "Re-check",
        unknown: "Unable to confirm local CLI status — refresh to re-check"
      },
      launchpad: {
        agentUnavailable: "Unavailable",
        appUnavailable: "Unavailable",
        clearSearch: "Clear search",
        close: "Close Launchpad",
        dockLabel: "Launchpad",
        empty: "No matching apps or agents",
        pageDot: "Page {{page}} of {{pageCount}}",
        pages: "Launchpad pages",
        searchPlaceholder: "Search",
        unavailableItem: "{{title}}, {{reason}}"
      },
      missionControl: {
        activateShortcutDefault: "Ctrl + 1",
        activateShortcutMac: "Cmd + 1",
        activateTrigger: "Quick activate node",
        layoutShortcutDefault: "Ctrl + 2",
        layoutShortcutMac: "Cmd + 2",
        layoutTrigger: "Quick layout",
        unavailableTrigger: "Available when multiple windows exist",
        unlockLayoutTrigger: "Unlock layout"
      }
    }
  },
  errors: {
    daemon_unavailable: "The local runtime is unavailable right now.",
    electron_debug_required:
      "This action is only available in Electron. Please switch back to desktop debugging for it.",
    invalid_request: {
      default: "That request could not be completed.",
      empty_body: "The request body was missing.",
      entry_already_exists: "That file or folder already exists at this path.",
      invalid_entry_kind: "That file action used an unsupported entry type.",
      invalid_path: "That path is invalid.",
      invalid_upload_source:
        "One or more upload sources are invalid or unavailable.",
      invalid_workbench_snapshot:
        "That workbench state could not be saved because the snapshot is invalid.",
      agent: {
        prompt_image_unsupported: "This agent does not support image input yet."
      },
      malformed_request: "We couldn't understand that request.",
      missing_workspace_id: "Choose a workspace before trying again.",
      missing_workspace_name: "Enter a workspace name to continue.",
      path_escapes_root: "That path points outside the workspace root.",
      root_delete_forbidden: "The workspace root folder cannot be deleted.",
      workspace_app_icon_invalid:
        "Choose a PNG, JPG, or WebP image under 5 MB.",
      workspace_app_icon_replace_forbidden:
        "Only generated apps can replace their icon.",
      workspace_app_package_exists: "This app version already exists."
    },
    method_not_allowed: "That action is not available for this request.",
    logger_file_unavailable: "The local logger is temporarily unavailable.",
    managed_process_exited: "The local runtime stopped unexpectedly.",
    managed_process_stderr: "The local runtime reported an internal error.",
    node_runtime_broken:
      "The Node.js runtime used by npm is broken. Check your terminal Node/npm setup, then try again.",
    workspace_app_launch_requires_retry:
      "This app failed to start. Click Retry before opening it.",
    preview_file_too_large: "This file is too large to preview here.",
    service_unavailable: {
      default: "That service is temporarily unavailable.",
      workspace_file_service_unavailable:
        "Workspace files are temporarily unavailable.",
      workspace_service_unavailable: "Workspaces are temporarily unavailable.",
      workspace_workbench_service_unavailable:
        "The workspace workbench is temporarily unavailable."
    },
    transport_connect_failed: "We couldn't connect to the local runtime.",
    transport_request_failed:
      "An unexpected service error occurred. Please try again.",
    transport_timeout: "That desktop request timed out.",
    workspace_app_factory_publish_failed:
      "The app draft did not pass its pre-publish check. Fix it from App Center before publishing.",
    workspace_file_not_found:
      "That file or folder could not be found in the workspace.",
    workspace_not_found: "That workspace could not be found.",
    workspace_operation_failed: {
      default: "We couldn't finish that workspace action right now.",
      acp_adapter_version_mismatch:
        "The local agent adapter is unavailable or version-mismatched. Reconnect the agent from the dock, then try again."
    }
  }
} as const;
