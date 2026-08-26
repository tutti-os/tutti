export const enAgentGuiSlashPalette = {
  slashCommands: {
    help: {
      label: "help",
      description: "Show available commands and help."
    },
    mcp: {
      label: "MCP",
      description: "Manage MCP servers."
    },
    tasks: {
      label: "tasks",
      description: "View and manage background tasks."
    }
  },
  slashCommandPalette: "Slash commands",
  skillPickerPalette: "Skills",
  slashPaletteCommandsGroup: "Commands",
  slashPaletteCapabilitiesGroup: "Capabilities",
  slashPaletteCapabilitiesLoading: "Loading capabilities…",
  slashPaletteSkillsGroup: "Skills",
  slashPalettePluginsGroup: "Plugins",
  slashPaletteConnectorsGroup: "Connectors",
  slashPaletteConnectorConnected: "Authorized",
  slashPaletteConnectorNotConnected: "Connect",
  slashPaletteConnectorUnsupported: "Unsupported",
  slashPaletteMcpGroup: "MCP"
} as const;
