import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import type {
  AgentComposerFileMentionStatus,
  AgentFileMentionSuggestionState,
  AgentContextMentionItem
} from "./agentFileMentionExtension";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import type { AgentCapabilityTokenOption } from "./agentCapabilityTokenExtension";
import type { AgentRichTextPromptImage } from "./agentRichTextPromptImages";
import type { AgentGUIComposerFocusMethod } from "../engagement/agentGUIEngagement.types";

export interface AgentRichTextEditorProps {
  value: string;
  disabled: boolean;
  placeholder: string;
  removeMentionLabel?: string;
  className?: string;
  onChange: (value: string) => void;
  onContentLayoutInvalidated?: () => void;
  onFocus?: (method: AgentGUIComposerFocusMethod) => void;
  onUserContentChange?: (value: string) => void;
  onSubmit: () => void;
  onSubmitGuidance?: () => void;
  availableSkills?: readonly AgentGUIProviderSkillOption[];
  availableCapabilities?: readonly AgentCapabilityTokenOption[];
  submitOnEnter?: boolean;
  enableFileMentionSuggestions?: boolean;
  onKeyDownForPalette?: (event: KeyboardEvent) => boolean;
  onFileMentionSuggestionChange?: (
    state: AgentFileMentionSuggestionState | null
  ) => void;
  onFileMentionSuggestionKeyDown?: (event: KeyboardEvent) => boolean;
  onLinkClick?: (href: string) => void;
  promptImagesSupported?: boolean;
  onPromptImagesUnsupported?: () => void;
  onPasteImages?: (images: AgentRichTextPastedImage[]) => void;
  onPasteLargeText?: (text: string) => void;
  onPasteFiles?: (files: readonly File[]) => void;
  onDropFiles?: (files: readonly File[]) => void;
}

export interface AgentRichTextEditorHandle {
  focusAtStart: () => void;
  focusAtEnd: () => void;
  getPromptTextBeforeSelection: () => string;
  insertPlainTextAtSelection: (text: string) => string | null;
  openMentionPalette: () => void;
  insertWorkspaceReferences: (items: readonly WorkspaceFileReference[]) => void;
  insertMentionItems: (items: readonly AgentContextMentionItem[]) => void;
  insertComposerFiles: (
    items: readonly AgentRichTextComposerFileMention[]
  ) => void;
  updateComposerFiles: (
    items: readonly AgentRichTextComposerFileMention[]
  ) => boolean;
  replaceTextBeforeSelection: (length: number, text: string) => string | null;
}

export interface AgentRichTextComposerFileMention {
  errorCode?: string;
  id: string;
  name: string;
  status: AgentComposerFileMentionStatus;
}

export type AgentRichTextPastedImage = AgentRichTextPromptImage;

export interface AgentRichTextContextMenuState {
  canEdit: boolean;
  hasSelection: boolean;
  selectionFrom: number;
  selectionTo: number;
  x: number;
  y: number;
}

// Aligns with the Codex desktop composer: a paste is treated as a large-text
// attachment purely by character count (no line-count heuristic).
