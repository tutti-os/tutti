export const zhCNAgentGuiQuickPrompts = {
  add: "新增提示词",
  conflict: "该提示词已在其他窗口发生变化，请刷新后检查草稿再保存",
  contentLabel: "提示词",
  contentPlaceholder: "输入可重复使用的提示词内容",
  contentTooLarge: "提示词内容不能超过 32 KiB",
  createTitle: "新增快捷提示词",
  createFromTemplate: "从推荐模板创建",
  delete: "删除",
  deleteConfirm: "删除提示词",
  deleteDescription: "确定删除「{{title}}」吗？删除后无法恢复",
  deleteTitle: "删除快捷提示词？",
  deleting: "正在删除…",
  dragCancel:
    "已取消排序，「{{title}}」返回第 {{position}} 项，共 {{total}} 项",
  dragDrop: "已将「{{title}}」放到第 {{position}} 项，共 {{total}} 项",
  dragHandle: "调整「{{title}}」的顺序",
  dragInstructions:
    "按空格键或回车键开始拖拽，使用方向键移动，再按空格键或回车键放下，按 Esc 键取消",
  dragMove: "正在把「{{title}}」移动到第 {{position}} 项，共 {{total}} 项",
  dragStart: "已选中「{{title}}」，当前第 {{position}} 项，共 {{total}} 项",
  edit: "编辑",
  editTitle: "编辑快捷提示词",
  empty: "暂无快捷提示词",
  finishSorting: "完成",
  loadError: "快捷提示词加载失败",
  loading: "正在加载快捷提示词…",
  moreActions: "更多提示词操作",
  mutationError: "提示词保存失败，请重试",
  noResults: "没有匹配的快捷提示词",
  required: "标题和提示词内容不能为空",
  reorderConflict: "提示词顺序已在其他窗口发生变化，请刷新后重新拖拽",
  reorderError: "提示词顺序保存失败，请重新拖拽",
  retry: "重试",
  recommendedTemplates: {
    understandContext: {
      title: "梳理现状",
      description: "总结上下文、约束、风险与下一步",
      content:
        "请先总结当前上下文、已确认的事实、约束、风险和待确认问题，区分事实与假设，再给出最小且有价值的下一步建议"
    },
    createActionPlan: {
      title: "制定行动计划",
      description: "拆分优先级、依赖与验收标准",
      content:
        "请把这个目标拆成按优先级排序且可验证的步骤，列出每一步的依赖、风险和验收标准，并建议从哪里开始"
    },
    reviewAndImprove: {
      title: "审阅与改进",
      description: "找出缺口、风险和可执行的优化建议",
      content:
        "请审阅以下内容，说明做得好的部分、缺失的信息、重要风险和可执行的改进建议，并按影响与投入排序"
    },
    draftClearUpdate: {
      title: "生成清晰说明",
      description: "面向目标受众生成简洁表达",
      content:
        "请为目标受众生成一段简洁说明，先表达核心信息，只补充必要上下文，明确需要对方做出的决策或下一步行动，并使用清晰直接的语言"
    }
  },
  recommendedTemplatesDescription:
    "选择后会预填到编辑窗口，保存前不会创建或发送提示词",
  recommendedTemplatesTitle: "推荐模板",
  returnToPrompts: "我的提示词",
  save: "保存",
  saving: "正在保存…",
  searchPlaceholder: "搜索快捷提示词",
  startSorting: "排序",
  title: "快捷提示词",
  titleLabel: "标题",
  titlePlaceholder: "输入简短易识别的名称",
  titleTooLong: "标题不能超过 80 个字符",
  trigger: "提示词",
  triggerTooltip: "选择快捷提示词",
  useTemplate: "使用模板"
} as const;
