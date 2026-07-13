import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import type {
  AgentFileMentionSuggestionState,
  AgentContextMentionItem
} from "./agentFileMentionExtension";
import type { AgentGUIProviderSkillOption } from "../model/agentGuiNodeTypes";
import type { AgentCapabilityTokenOption } from "./agentCapabilityTokenExtension";
import type { AgentRichTextPromptImage } from "./agentRichTextPromptImages";

export interface AgentRichTextEditorProps {
  value: string;
  disabled: boolean;
  placeholder: string;
  removeMentionLabel?: string;
  className?: string;
  onChange: (value: string) => void;
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
  getReferenceForFile?: (file: File) => WorkspaceFileReference | null;
  onDropFiles?: (files: readonly File[]) => void;
}

export interface AgentRichTextEditorHandle {
  focusAtStart: () => void;
  focusAtEnd: () => void;
  getPromptTextBeforeSelection: () => string;
  openMentionPalette: () => void;
  insertWorkspaceReferences: (items: readonly WorkspaceFileReference[]) => void;
  insertMentionItems: (items: readonly AgentContextMentionItem[]) => void;
  replaceTextBeforeSelection: (length: number, text: string) => string | null;
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
