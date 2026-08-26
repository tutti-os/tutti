export const zhCNAgentGuiSlashPalette = {
  slashCommands: {
    help: {
      label: "帮助",
      description: "查看可用命令和帮助"
    },
    mcp: {
      label: "MCP 服务",
      description: "管理 MCP 服务"
    },
    tasks: {
      label: "任务",
      description: "查看和管理后台任务"
    }
  },
  slashCommandPalette: "斜杠菜单",
  skillPickerPalette: "技能",
  slashPaletteCommandsGroup: "命令",
  slashPaletteCapabilitiesGroup: "能力",
  slashPaletteCapabilitiesLoading: "能力加载中…",
  slashPaletteSkillsGroup: "技能",
  slashPalettePluginsGroup: "插件",
  slashPaletteConnectorsGroup: "连接器",
  slashPaletteConnectorConnected: "已授权",
  slashPaletteConnectorNotConnected: "安装",
  slashPaletteConnectorUnsupported: "不支持",
  slashPaletteMcpGroup: "MCP"
} as const;
