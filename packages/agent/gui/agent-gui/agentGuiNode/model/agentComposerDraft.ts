import { createRichTextMentionMarkdown } from "@tutti-os/ui-rich-text/core";
import type { AgentPromptContentBlock } from "../../../shared/contracts/dto";
import type {
  AgentComposerDraft,
  AgentComposerDraftFile,
  AgentComposerDraftLargeText,
  AgentComposerDraftImage,
  AgentGUIProviderSkillOption
} from "./agentGuiNodeTypes";
import {
  AGENT_PASTED_TEXT_BLOCK_KIND,
  AGENT_PASTED_TEXT_MENTION_KIND
} from "./agentGuiNodeTypes";

const PASTED_TEXT_MENTION_PREVIEW_MAX_CHARS = 10;

/**
 * First {@link PASTED_TEXT_MENTION_PREVIEW_MAX_CHARS} characters of the pasted
 * body (collapsed to a single line), used as the chip label everywhere. Markdown
 * link-label metacharacters are stripped so it round-trips through the
 * `[preview](path)` reference the persisted content carries.
 */
export function pastedTextPreview(text: string): string {
  const collapsed = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[[\]()]/g, "");
  if (collapsed.length <= PASTED_TEXT_MENTION_PREVIEW_MAX_CHARS) {
    return collapsed;
  }
  return `${collapsed.slice(0, PASTED_TEXT_MENTION_PREVIEW_MAX_CHARS)}…`;
}

/**
 * First non-empty line of the pasted body, trimmed and length-capped, used as
 * the chip's primary label in the conversation flow. Falls back to the display
 * file name when the body is unavailable (e.g. a queue-restored item).
 */
function pastedTextPreviewLabel(
  item: AgentComposerDraftLargeText,
  index: number
): string {
  return (
    pastedTextPreview(item.text) ||
    item.name.trim() ||
    pastedTextDraftDisplayName(index)
  );
}

/**
 * Encodes a landed pasted-text item as a canonical mention link for the
 * conversation-flow display prompt. The href (a `mention://pasted-text/...`
 * URL) losslessly carries the archive `path` and byte size so the host can
 * render a chip and open a preview on click — the persisted, reload-safe
 * "custom protocol" for pasted text. Returns "" when the item has not landed.
 */
export function pastedTextMentionMarkdown(
  item: AgentComposerDraftLargeText,
  index: number
): string {
  const path = item.path?.trim();
  if (!path) {
    return "";
  }
  return createRichTextMentionMarkdown({
    providerId: AGENT_PASTED_TEXT_MENTION_KIND,
    entityId: item.id,
    label: pastedTextPreviewLabel(item, index),
    scope: {
      path,
      ...(typeof item.sizeBytes === "number" && Number.isFinite(item.sizeBytes)
        ? { size: String(item.sizeBytes) }
        : {})
    }
  });
}
import {
  promptForProviderSkills,
  skillTriggerForPrefix
} from "./agentSkillOptions";

export const MAX_AGENT_COMPOSER_DRAFT_IMAGES = 8;

type AgentPromptImageContentBlock = AgentPromptContentBlock & {
  type: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  attachmentId?: string;
  data?: string;
  path?: string;
};

export function emptyAgentComposerDraft(): AgentComposerDraft {
  return { prompt: "", images: [], files: [] };
}

export function agentComposerDraftHasContent(
  draft: AgentComposerDraft
): boolean {
  return (
    draft.prompt.trim() !== "" ||
    draft.images.length > 0 ||
    (draft.files?.length ?? 0) > 0 ||
    (draft.largeTexts?.some(
      (item) => item.text.trim() !== "" || Boolean(item.path)
    ) ??
      false)
  );
}

export function normalizeAgentPromptContentBlocks(
  content: readonly AgentPromptContentBlock[]
): AgentPromptContentBlock[] {
  const result: AgentPromptContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") {
      const text = block.text?.trim() ?? "";
      if (text) {
        result.push({ type: "text", text });
      }
      continue;
    }
    if (block.type === "image") {
      const mimeType = block.mimeType?.trim();
      const attachmentId = block.attachmentId?.trim();
      const data = block.data?.trim();
      const imagePath = block.path?.trim();
      if (
        (!attachmentId && !data && !imagePath) ||
        (mimeType !== "image/png" &&
          mimeType !== "image/jpeg" &&
          mimeType !== "image/webp")
      ) {
        continue;
      }
      result.push({
        type: "image",
        mimeType,
        ...(attachmentId
          ? { attachmentId }
          : imagePath
            ? { path: imagePath }
            : { data }),
        ...(block.name?.trim() ? { name: block.name.trim() } : {})
      });
      continue;
    }
    if (block.type === "file") {
      const filePath = block.path?.trim();
      const hostPath = block.hostPath?.trim();
      if (!filePath && !hostPath) {
        continue;
      }
      result.push({
        type: "file",
        ...(block.mimeType?.trim() ? { mimeType: block.mimeType.trim() } : {}),
        ...(filePath ? { path: filePath } : {}),
        ...(hostPath ? { hostPath } : {}),
        ...(block.name?.trim() ? { name: block.name.trim() } : {}),
        ...(block.uri?.trim() ? { uri: block.uri.trim() } : {}),
        ...(block.uploadStatus?.trim()
          ? { uploadStatus: block.uploadStatus.trim() }
          : {}),
        ...(block.assetId?.trim() ? { assetId: block.assetId.trim() } : {}),
        ...(typeof block.sizeBytes === "number"
          ? { sizeBytes: block.sizeBytes }
          : {}),
        kind:
          block.kind === AGENT_PASTED_TEXT_BLOCK_KIND
            ? AGENT_PASTED_TEXT_BLOCK_KIND
            : "file"
      });
      continue;
    }
    if (block.type === "skill" || block.type === "mention") {
      const name = block.name?.trim();
      const path = block.path?.trim();
      if (name && path) {
        result.push({ type: block.type, name, path });
      }
    }
  }
  return result;
}

export function agentPromptContentDisplayText(
  content: readonly AgentPromptContentBlock[]
): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

export function agentPromptContentHasImage(
  content: readonly AgentPromptContentBlock[]
): boolean {
  return content.some((block) => block.type === "image");
}

export function agentPromptContentHasFile(
  content: readonly AgentPromptContentBlock[]
): boolean {
  return content.some((block) => block.type === "file");
}

export function agentPromptContentImageBlocks(
  content: readonly AgentPromptContentBlock[]
): AgentPromptImageContentBlock[] {
  return normalizeAgentPromptContentBlocks(content).filter(
    (block): block is AgentPromptImageContentBlock =>
      block.type === "image" &&
      (typeof block.attachmentId === "string" ||
        typeof block.data === "string" ||
        typeof block.path === "string") &&
      typeof block.mimeType === "string"
  );
}

export function agentPromptContentToComposerDraft(
  content: readonly AgentPromptContentBlock[],
  idPrefix: string
): AgentComposerDraft {
  const normalizedContent = normalizeAgentPromptContentBlocks(content);
  const largeTexts = agentPromptPastedTextBlocks(normalizedContent).map(
    (block) => agentPromptPastedTextBlockToDraftLargeText(block)
  );
  return {
    prompt: agentPromptContentDisplayText(normalizedContent),
    images: agentPromptContentImageBlocks(normalizedContent)
      .slice(0, MAX_AGENT_COMPOSER_DRAFT_IMAGES)
      .map((image, index) =>
        agentPromptImageBlockToDraftImage(image, idPrefix, index)
      ),
    files: agentPromptFileBlocks(normalizedContent).map((file, index) =>
      agentPromptFileBlockToDraftFile(file, idPrefix, index)
    ),
    ...(largeTexts.length > 0 ? { largeTexts } : {})
  };
}

function agentPromptPastedTextBlockToDraftLargeText(
  block: AgentPromptContentBlock & { type: "file" }
): AgentComposerDraftLargeText {
  return {
    id: crypto.randomUUID(),
    name: block.name?.trim() || "pasted-text.txt",
    text: "",
    ...(block.path ? { path: block.path } : {}),
    ...(typeof block.sizeBytes === "number"
      ? { sizeBytes: block.sizeBytes }
      : {})
  };
}

export function agentComposerDraftToPromptContent(input: {
  draft: AgentComposerDraft;
  provider: string;
  skills: readonly AgentGUIProviderSkillOption[];
}): AgentPromptContentBlock[] {
  const prompt = promptForProviderSkills({
    prompt: input.draft.prompt,
    provider: input.provider,
    skills: input.skills
  });
  return normalizeAgentPromptContentBlocks([
    ...textPromptContent(prompt),
    ...promptItemBlocksForProviderSkills({
      prompt,
      provider: input.provider,
      skills: input.skills
    }),
    ...input.draft.images
      .slice(0, MAX_AGENT_COMPOSER_DRAFT_IMAGES)
      .filter((image) => !image.uploading && !image.uploadError)
      .map((image) => ({
        type: "image" as const,
        mimeType: image.mimeType,
        ...(image.attachmentId
          ? { attachmentId: image.attachmentId }
          : image.path
            ? { path: image.path }
            : { data: image.data }),
        name: image.name
      })),
    ...(input.draft.files ?? [])
      .filter((file) => !file.uploading && !file.uploadError)
      .map((file) => ({
        type: "file" as const,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...(file.path ? { path: file.path } : {}),
        ...(!file.path && file.hostPath ? { hostPath: file.hostPath } : {}),
        ...(file.assetId ? { assetId: file.assetId } : {}),
        ...(file.sizeBytes ? { sizeBytes: file.sizeBytes } : {}),
        name: file.name,
        kind: "file"
      })),
    ...largeTextPromptContent(input.draft.largeTexts ?? [])
  ]);
}

export function agentComposerDraftSubmittedText(
  draft: AgentComposerDraft
): string {
  return agentPromptContentDisplayText(
    normalizeAgentPromptContentBlocks([
      ...textPromptContent(draft.prompt),
      ...largeTextPromptContent(draft.largeTexts ?? [])
    ])
  );
}

export function agentComposerDraftDisplayPrompt(
  draft: AgentComposerDraft
): string | undefined {
  const largeTexts = draft.largeTexts?.filter(
    (item) => Boolean(item.path) && !item.uploading && !item.uploadError
  );
  if (!largeTexts?.length) {
    return undefined;
  }
  const parts = [draft.prompt.trim()].filter(Boolean);
  parts.push(
    ...largeTexts
      .map((item, index) => pastedTextMentionMarkdown(item, index))
      .filter(Boolean)
  );
  return parts.join("\n");
}

function agentPromptFileBlocks(
  content: readonly AgentPromptContentBlock[]
): Array<AgentPromptContentBlock & { type: "file" }> {
  return normalizeAgentPromptContentBlocks(content).filter(
    (block): block is AgentPromptContentBlock & { type: "file" } =>
      block.type === "file" &&
      !isPastedTextPromptBlock(block) &&
      (typeof block.path === "string" || typeof block.hostPath === "string")
  );
}

function agentPromptPastedTextBlocks(
  content: readonly AgentPromptContentBlock[]
): Array<AgentPromptContentBlock & { type: "file" }> {
  return normalizeAgentPromptContentBlocks(content).filter(
    (block): block is AgentPromptContentBlock & { type: "file" } =>
      isPastedTextPromptBlock(block) && typeof block.path === "string"
  );
}

function promptItemBlocksForProviderSkills(input: {
  prompt: string;
  provider: string;
  skills: readonly AgentGUIProviderSkillOption[];
}): AgentPromptContentBlock[] {
  if (input.provider.trim() !== "codex") {
    return [];
  }
  const result: AgentPromptContentBlock[] = [];
  for (const skill of input.skills) {
    const path = skill.path?.trim();
    if (!path) {
      continue;
    }
    const trigger = skillTriggerForPrefix(skill, "$");
    if (!trigger || !promptHasTrigger(input.prompt, trigger)) {
      continue;
    }
    result.push({
      type: skill.kind === "connector" ? "mention" : "skill",
      name: skill.name,
      path
    });
  }
  return result;
}

function promptHasTrigger(prompt: string, trigger: string): boolean {
  return new RegExp(`(^|\\s)${escapeRegExp(trigger)}(?=$|\\s)`).test(prompt);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function textPromptContent(prompt: string): AgentPromptContentBlock[] {
  const text = prompt.trim();
  return text ? [{ type: "text", text }] : [];
}

/**
 * Display/label name for a pasted-text attachment, addressed purely by its
 * position in the draft (`pasted-text-1.txt`, `pasted-text-2.txt`, …). The
 * stored `item.name` is content-addressed and intentionally not used here, so
 * labels never collide and always renumber with the list.
 */
export function pastedTextDraftDisplayName(index: number): string {
  return `pasted-text-${index + 1}.txt`;
}

// Matches a landed pasted-text archive path (content-addressed .txt under the
// host's agent-prompt-assets dir). The path may contain spaces (e.g. macOS
// "Application Support"), so match from the leading "/" or drive letter up to
// the first ".txt" after "agent-prompt-assets", staying on one line.
const PASTED_TEXT_ARCHIVE_PATH_RE =
  /(?:\/|[A-Za-z]:\\)[^\n]*?agent-prompt-assets[^\n]*?\.txt/;

function firstPastedTextArchivePath(line: string): string | null {
  return line.match(PASTED_TEXT_ARCHIVE_PATH_RE)?.[0].trim() ?? null;
}

/**
 * Extracts landed pasted-text archive paths from a persisted content text block
 * (the codex-style "Referenced pasted text files:" instruction the agent
 * receives). This is the reload-safe source of truth for the chip — see
 * {@link linkifyPastedTextReferences}.
 */
export function extractPastedTextArchivePaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split("\n")) {
    const path = firstPastedTextArchivePath(line);
    if (path && !paths.includes(path)) {
      paths.push(path);
    }
  }
  return paths;
}

function pastedTextReferenceMentionMarkdown(
  preview: string,
  path: string,
  index: number
): string {
  return createRichTextMentionMarkdown({
    providerId: AGENT_PASTED_TEXT_MENTION_KIND,
    entityId: `ref-${index}`,
    label: preview.trim() || pastedTextDraftDisplayName(index),
    scope: { path }
  });
}

// The persisted instruction line embeds the preview quoted: `… "<preview>": …`.
function firstQuotedPreview(line: string): string {
  return line.match(/"([^"]*)"/)?.[1]?.trim() ?? "";
}

/**
 * Rewrites a persisted content text block that carries pasted-text references
 * into the same pasted-text mention chips the composer/display prompt produce,
 * so a reloaded message renders identical chips instead of the raw
 * "Referenced pasted text files: - pasted text file: <path>. Read this…" text.
 *
 * Mirrors the Codex approach (parse the agent-facing text back into attachment
 * chips): the pasted-text instruction is appended as its own content block, so a
 * block containing archive paths is entirely that section and is replaced by the
 * clean chip list (dropping the localized header/instruction wording). Blocks
 * without a pasted-text path are returned unchanged.
 */
export function linkifyPastedTextReferences(text: string): string {
  if (!PASTED_TEXT_ARCHIVE_PATH_RE.test(text)) {
    return text;
  }
  const lines = text.split("\n");
  const out: string[] = [];
  let refIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const path = firstPastedTextArchivePath(line);
    if (path) {
      out.push(
        pastedTextReferenceMentionMarkdown(
          firstQuotedPreview(line),
          path,
          refIndex
        )
      );
      refIndex += 1;
      continue;
    }
    // Drop the localized header line that directly precedes a reference line;
    // the pasted-text instruction always emits "<header>\n<refs>" as its own
    // block, so this only removes the header, never user text.
    const next = lines[i + 1];
    if (next != null && firstPastedTextArchivePath(next)) {
      continue;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * Pasted long text submits as a structured `file` block (content-addressed
 * archive path) tagged with {@link AGENT_PASTED_TEXT_BLOCK_KIND}. Only landed
 * items are emitted — same rule as images: still-uploading or errored items are
 * dropped from submit (a visible error chip remains for the user to retry or
 * remove). The codex-style "read this file" instruction is NOT added here; it
 * is materialized in the controller at send time via
 * {@link materializePastedTextInstructions} so translations never enter the
 * model layer or the persisted/queued draft.
 */
function largeTextPromptContent(
  largeTexts: readonly AgentComposerDraftLargeText[]
): AgentPromptContentBlock[] {
  return largeTexts
    .filter((item) => {
      const path = item.path?.trim();
      return Boolean(path) && !item.uploading && !item.uploadError;
    })
    .map((item, index) => ({
      type: "file" as const,
      kind: AGENT_PASTED_TEXT_BLOCK_KIND,
      path: item.path,
      // The preview (first chars of the pasted body) is the chip label; carry it
      // as the block name so the send-time instruction persists it in content.
      name: pastedTextPreviewLabel(item, index),
      ...(typeof item.sizeBytes === "number"
        ? { sizeBytes: item.sizeBytes }
        : {})
    }));
}

/**
 * True when a prompt `file` block is a pasted-text attachment rather than a
 * user-attached file.
 */
export function isPastedTextPromptBlock(
  block: AgentPromptContentBlock
): boolean {
  return block.type === "file" && block.kind === AGENT_PASTED_TEXT_BLOCK_KIND;
}

/**
 * Rewrites `content` for send: the structured pasted-text `file` blocks
 * (kept in the draft/queue so the composer can show a chip and restore it on
 * edit) are replaced by a single codex-style instruction text block at the tail
 * that references each landed file by path — mirroring the Codex desktop app,
 * which references pasted text as a plain "read this file" line rather than a
 * structured attachment. This also keeps the sent content free of `file` blocks,
 * which the desktop tuttid pipeline rejects. The instruction copy is passed in
 * already-translated so the model layer stays free of any i18n dependency. When
 * there are no pasted-text blocks the input is returned unchanged.
 */
export function materializePastedTextInstructions(
  content: readonly AgentPromptContentBlock[],
  format: {
    header: () => string;
    line: (preview: string, path: string) => string;
  }
): AgentPromptContentBlock[] {
  const pastedRefs = content
    .filter(isPastedTextPromptBlock)
    .map((block) => ({
      preview: sanitizePastedTextPreviewForContent(block.name),
      path: block.path?.trim() ?? ""
    }))
    .filter((ref) => ref.path !== "");
  if (pastedRefs.length === 0) {
    return [...content];
  }
  const withoutPastedText = content.filter(
    (block) => !isPastedTextPromptBlock(block)
  );
  const instruction = [
    format.header(),
    ...pastedRefs.map((ref) => format.line(ref.preview, ref.path))
  ].join("\n");
  return [...withoutPastedText, { type: "text", text: instruction }];
}

// The preview is embedded quoted in the persisted instruction line
// (`… "<preview>": <path> …`), so strip the quote/newline delimiters that would
// break the parse-back in {@link linkifyPastedTextReferences}.
function sanitizePastedTextPreviewForContent(name: string | undefined): string {
  return (name ?? "").replace(/["\n\r]/g, " ").trim();
}

export function formatAgentComposerDraftBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  const kib = sizeBytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  }
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

function agentPromptImageBlockToDraftImage(
  image: AgentPromptImageContentBlock,
  idPrefix: string,
  index: number
): AgentComposerDraftImage {
  return {
    id: `${idPrefix}:image:${index}`,
    name: image.name?.trim() || `image-${index + 1}`,
    mimeType: image.mimeType,
    ...(image.attachmentId ? { attachmentId: image.attachmentId } : {}),
    ...(image.data ? { data: image.data } : {}),
    ...(image.path ? { path: image.path } : {}),
    previewUrl:
      typeof image.data === "string" && image.data
        ? `data:${image.mimeType};base64,${image.data}`
        : (image.path ?? "")
  };
}

function agentPromptFileBlockToDraftFile(
  file: AgentPromptContentBlock & { type: "file" },
  idPrefix: string,
  index: number
): AgentComposerDraftFile {
  return {
    id: `${idPrefix}:file:${index}`,
    name: file.name?.trim() || `file-${index + 1}`,
    mimeType: file.mimeType,
    path: file.path,
    hostPath: file.hostPath,
    assetId: file.assetId,
    sizeBytes: file.sizeBytes
  };
}
