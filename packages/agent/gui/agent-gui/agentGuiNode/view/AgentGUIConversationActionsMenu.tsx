import {
  Fragment,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  AtSign,
  CircleDot,
  ExternalLink,
  FileText,
  MoreHorizontal,
  Pencil
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@tutti-os/ui-system";
import { BareIconButton } from "@tutti-os/ui-system/components";
import { resolveWorkspaceImageMimeType } from "@tutti-os/workspace-file-preview";
import { useOptionalAgentHostApi } from "../../../agentActivityHost";
import { useOptionalAgentActivityRuntime } from "../../../agentActivityRuntime";
import type { UiLanguage } from "../../../contexts/settings/domain/agentSettings";
import type {
  AgentHostToastHandle,
  AgentHostWorkspaceApi
} from "../../../host/agentHostApi";
import { blobToBase64 } from "../../../shared/agentConversation/lib/copyImageToClipboard";
import { createAgentSessionMarkdownLink } from "../agentRichText/agentFileMentionExtension";
import {
  loadCompleteAgentConversationMessages,
  serializeAgentConversationForClipboard,
  type AgentGUIConversationAttachment,
  type AgentGUIConversationCopyAction
} from "../model/agentConversationCopy";
import { renderAgentConversationCopyHtml } from "../model/agentConversationCopyHtml";
import type { AgentGUINodeViewModel } from "../model/agentGuiNodeTypes";
import type { AgentGUIViewLabels } from "./AgentGUINodeView.types";
import { conversationPlainTitle } from "./agentGUIViewUtils";

const menuContentClassName =
  "w-max min-w-44 nodrag [-webkit-app-region:no-drag]";

type Conversation = AgentGUINodeViewModel["rail"]["conversations"][number];

export interface AgentGUIClipboardPayload {
  html?: string;
  /** Overrides the default copied toast, e.g. omitted-image guidance. */
  successMessage?: string;
  text: string;
}

// Writes text/plain + text/html as one ClipboardItem so rich-paste targets
// (Word, Feishu docs, Notion, mail clients) receive the HTML flavor with real
// inline images. Returns false instead of throwing when the dual-format path
// is unavailable or denied, so the caller falls back to the host text-only
// clipboard and copying keeps working.
async function writeTextAndHtmlWithWebClipboard(
  text: string,
  html: string
): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.clipboard?.write !== "function" ||
    typeof ClipboardItem === "undefined"
  ) {
    return false;
  }
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" })
      })
    ]);
    return true;
  } catch {
    return false;
  }
}

// Hydrates a local workspace image path into base64 bytes for the transcript
// serializer, mirroring AgentGeneratedImagePreview's read and MIME resolution
// so the copied text/html flavor embeds the same bytes the GUI preview
// renders.
async function readWorkspaceImageAsAttachment(
  readFile: AgentHostWorkspaceApi["readFile"],
  input: { mimeType: string | null; path: string }
): Promise<AgentGUIConversationAttachment> {
  const result = await readFile({ path: input.path });
  const bytes =
    result.bytes instanceof Uint8Array
      ? result.bytes
      : new Uint8Array(result.bytes);
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const mimeType =
    input.mimeType?.trim() ||
    resolveWorkspaceImageMimeType(input.path) ||
    "image/png";
  return {
    data: await blobToBase64(new Blob([arrayBuffer], { type: mimeType })),
    mimeType
  };
}

export function useAgentGUIClipboardWriter(
  labels: Pick<AgentGUIViewLabels, "copiedToClipboard" | "copyFailed">
): (
  value: string | AgentGUIClipboardPayload,
  toastHandle?: AgentHostToastHandle
) => void {
  const agentHostApi = useOptionalAgentHostApi();
  return useCallback(
    (value, toastHandle) => {
      const payload = typeof value === "string" ? { text: value } : value;
      const clipboard = agentHostApi?.clipboard;
      if (typeof clipboard?.writeText !== "function") {
        (toastHandle?.reject ?? agentHostApi?.toast?.error)?.(
          labels.copyFailed
        );
        return;
      }
      // The write runs inside then() so a synchronous throw still lands in
      // catch instead of escaping the deferred menu-action callback.
      void Promise.resolve()
        .then(async () => {
          if (
            payload.html &&
            (await writeTextAndHtmlWithWebClipboard(payload.text, payload.html))
          ) {
            return;
          }
          await clipboard.writeText(payload.text);
        })
        .then(() => {
          if (payload.successMessage) {
            // Guidance-style success (e.g. omitted oversized images) settles
            // to the neutral/info tone instead of a plain success.
            (
              toastHandle?.info ??
              agentHostApi?.toast?.info ??
              toastHandle?.resolve ??
              agentHostApi?.toast?.success
            )?.(payload.successMessage);
          } else {
            (toastHandle?.resolve ?? agentHostApi?.toast?.success)?.(
              labels.copiedToClipboard
            );
          }
        })
        .catch(() => {
          (toastHandle?.reject ?? agentHostApi?.toast?.error)?.(
            labels.copyFailed
          );
        });
    },
    [agentHostApi, labels.copiedToClipboard, labels.copyFailed]
  );
}

export function useAgentGUIConversationCopyAction(
  labels: Pick<
    AgentGUIViewLabels,
    | "conversationCopyFile"
    | "conversationCopyImage"
    | "conversationCopyImagesOmitted"
    | "conversationCopyInProgress"
    | "conversationCopyMentionPrefix"
    | "conversationCopyPreviousMessages"
    | "copiedToClipboard"
    | "copyFailed"
    | "untitledConversationTitle"
  >
): (
  action: AgentGUIConversationCopyAction,
  input: {
    conversation: Conversation;
    uiLanguage: UiLanguage;
    workspaceId: string;
  }
) => void {
  const agentHostApi = useOptionalAgentHostApi();
  const agentActivityRuntime = useOptionalAgentActivityRuntime();
  const writeClipboardValue = useAgentGUIClipboardWriter(labels);
  return useCallback(
    (action, { conversation, uiLanguage, workspaceId }) => {
      if (action === "copy-reference") {
        // Same serialized form as an @-panel session mention, so pasting into
        // any Tutti composer reconstructs the session chip.
        writeClipboardValue(
          createAgentSessionMarkdownLink({
            agentSessionId: conversation.id,
            agentTargetId: conversation.agentTargetId,
            label: conversationPlainTitle(conversation, labels, uiLanguage),
            workspaceId,
            withAtPrefix: true
          })
        );
        return;
      }
      if (!agentActivityRuntime) {
        agentHostApi?.toast?.error(labels.copyFailed);
        return;
      }
      const readSessionAttachment = agentActivityRuntime.readSessionAttachment;
      const readWorkspaceFile = agentHostApi?.workspace?.readFile;
      // History load + image hydration can take a noticeable moment on long
      // conversations. One toast opens busy immediately and settles in
      // place once the copy lands, instead of a separate toast per phase.
      // Hosts without the loading capability get the plain info toast they
      // always had, and the eventual result falls back to a second toast.
      const toastHandle = agentHostApi?.toast?.loading?.(
        labels.conversationCopyInProgress
      );
      if (!toastHandle) {
        agentHostApi?.toast?.info?.(labels.conversationCopyInProgress);
      }
      void (async () => {
        const messages = await loadCompleteAgentConversationMessages({
          agentSessionId: conversation.id,
          runtime: agentActivityRuntime,
          workspaceId
        });
        const transcript = await serializeAgentConversationForClipboard({
          labels: {
            file: labels.conversationCopyFile,
            image: labels.conversationCopyImage,
            mentionPrefix: labels.conversationCopyMentionPrefix,
            previousMessages: labels.conversationCopyPreviousMessages
          },
          messages,
          ...(readSessionAttachment
            ? {
                readAttachment: (attachmentId: string) =>
                  readSessionAttachment({
                    agentSessionId: conversation.id,
                    attachmentId,
                    workspaceId
                  })
              }
            : {}),
          ...(typeof readWorkspaceFile === "function"
            ? {
                readLocalImage: (target: {
                  mimeType: string | null;
                  path: string;
                }) => readWorkspaceImageAsAttachment(readWorkspaceFile, target)
              }
            : {}),
          title: conversationPlainTitle(conversation, labels, uiLanguage)
        });
        let html: string | undefined;
        try {
          html =
            renderAgentConversationCopyHtml(transcript.hydratedMarkdown) ||
            undefined;
        } catch {
          // A rendering failure must degrade to the text-only copy instead of
          // failing the whole action.
          html = undefined;
        }
        // Oversized/unreadable images stay out of the copy; the success toast
        // tells the user how many and points at per-image copy instead.
        const successMessage =
          transcript.omittedImages > 0
            ? labels.conversationCopyImagesOmitted.replace(
                "{{count}}",
                `${transcript.omittedImages}`
              )
            : undefined;
        writeClipboardValue(
          {
            ...(html ? { html } : {}),
            ...(successMessage ? { successMessage } : {}),
            text: transcript.markdown
          },
          toastHandle
        );
      })().catch(() => {
        (toastHandle?.reject ?? agentHostApi?.toast?.error)?.(
          labels.copyFailed
        );
      });
    },
    [agentActivityRuntime, agentHostApi, labels, writeClipboardValue]
  );
}

type ConversationActionEntry = {
  disabled?: boolean;
  icon: ReactNode;
  id: string;
  label: string;
  onSelect: () => void;
};

type ConversationActionsMenuLabels = Pick<
  AgentGUIViewLabels,
  | "copiedToClipboard"
  | "copyAsMarkdown"
  | "copyAsReference"
  | "copyFailed"
  | "conversationCopyFile"
  | "conversationCopyImage"
  | "conversationCopyImagesOmitted"
  | "conversationCopyInProgress"
  | "conversationCopyMentionPrefix"
  | "conversationCopyPreviousMessages"
  | "markSessionUnread"
  | "moreSessionActions"
  | "openConversationWindow"
  | "renameSession"
  | "untitledConversationTitle"
>;

interface AgentGUIConversationActionsMenuProps {
  conversation: Conversation;
  labels: ConversationActionsMenuLabels;
  uiLanguage: UiLanguage;
  workspaceId: string;
  canMarkUnread: boolean;
  isInteractionLocked: () => boolean;
  onMarkConversationUnread: (agentSessionId: string) => void;
  onOpenConversationWindow?: (agentSessionId: string) => void;
  onRequestRenameConversation: (conversation: Conversation) => void;
}

export interface AgentGUIConversationActionsMenuState {
  groups: ConversationActionEntry[][];
  resetKey: number;
}

export function useConversationActionGroups({
  conversation,
  labels,
  uiLanguage,
  workspaceId,
  canMarkUnread,
  isInteractionLocked,
  onMarkConversationUnread,
  onOpenConversationWindow,
  onRequestRenameConversation
}: AgentGUIConversationActionsMenuProps): AgentGUIConversationActionsMenuState {
  const agentHostApi = useOptionalAgentHostApi();
  const agentActivityRuntime = useOptionalAgentActivityRuntime();
  const copyConversationValue = useAgentGUIConversationCopyAction(labels);
  const [resetKey, setResetKey] = useState(0);
  const pendingActionRef = useRef(false);
  // The pending ref dedups the select/click/pointerup handlers a single
  // gesture can fire. Remounting closes a fallback-only (dead-click) menu.
  const run = useCallback(
    (action: () => void) => {
      if (pendingActionRef.current) {
        return;
      }
      pendingActionRef.current = true;
      setResetKey((key) => key + 1);
      // timing: defer one tick so Radix teardown finishes before the action and the pending ref outlives the gesture's duplicate select/click/pointerup events
      window.setTimeout(() => {
        pendingActionRef.current = false;
        if (!isInteractionLocked()) {
          action();
        }
      }, 0);
    },
    [isInteractionLocked]
  );

  const groups = useMemo(() => {
    const clipboardUnavailable =
      typeof agentHostApi?.clipboard?.writeText !== "function";
    const copyItem = (
      action: AgentGUIConversationCopyAction,
      icon: ReactNode,
      label: string,
      disabled = false
    ): ConversationActionEntry => ({
      // copy-reference builds the mention link synchronously from the
      // conversation identity; only copy-markdown reads history through the
      // runtime, so only it is gated on runtime presence.
      disabled:
        clipboardUnavailable ||
        (action === "copy-markdown" && !agentActivityRuntime) ||
        disabled,
      icon,
      id: action,
      label,
      onSelect: () =>
        run(() =>
          copyConversationValue(action, {
            conversation,
            uiLanguage,
            workspaceId
          })
        )
    });
    return [
      [
        {
          icon: <Pencil aria-hidden="true" />,
          id: "rename",
          label: labels.renameSession,
          onSelect: () => run(() => onRequestRenameConversation(conversation))
        },
        copyItem(
          "copy-markdown",
          <FileText aria-hidden="true" />,
          labels.copyAsMarkdown
        ),
        copyItem(
          "copy-reference",
          <AtSign aria-hidden="true" />,
          labels.copyAsReference
        )
      ],
      [
        ...(onOpenConversationWindow
          ? [
              {
                icon: <ExternalLink aria-hidden="true" />,
                id: "open-window",
                label: labels.openConversationWindow,
                onSelect: () =>
                  run(() => onOpenConversationWindow(conversation.id))
              }
            ]
          : []),
        {
          disabled: !canMarkUnread,
          icon: <CircleDot aria-hidden="true" />,
          id: "mark-unread",
          label: labels.markSessionUnread,
          onSelect: () => run(() => onMarkConversationUnread(conversation.id))
        }
      ]
    ];
  }, [
    agentActivityRuntime,
    agentHostApi?.clipboard,
    canMarkUnread,
    conversation,
    copyConversationValue,
    labels,
    onMarkConversationUnread,
    onOpenConversationWindow,
    onRequestRenameConversation,
    run,
    uiLanguage,
    workspaceId
  ]);
  return { groups, resetKey };
}

export function AgentGUIConversationActionsDropdown({
  buttonClassName,
  menu,
  moreSessionActionsLabel
}: {
  buttonClassName?: string;
  menu: AgentGUIConversationActionsMenuState;
  moreSessionActionsLabel: string;
}): React.JSX.Element {
  // Menu content mounts only while open: every rail row renders a trigger,
  // and mounting per-row Radix content eagerly multiplies rail render cost.
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu key={menu.resetKey} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <BareIconButton
          className={buttonClassName}
          aria-label={moreSessionActionsLabel}
          title={moreSessionActionsLabel}
          size="md"
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <MoreHorizontal aria-hidden="true" />
        </BareIconButton>
      </DropdownMenuTrigger>
      {open ? (
        <DropdownMenuContent
          align="end"
          className={menuContentClassName}
          sideOffset={6}
        >
          <DropdownActionGroups groups={menu.groups} />
        </DropdownMenuContent>
      ) : null}
    </DropdownMenu>
  );
}

export function AgentGUIConversationActionsContextMenu({
  children,
  menu
}: {
  children: ReactNode;
  menu: AgentGUIConversationActionsMenuState;
}): React.JSX.Element {
  // Same lazy mount as the dropdown: content exists only while open so a
  // long rail does not pay per-row menu render cost.
  const [open, setOpen] = useState(false);
  return (
    <ContextMenu key={menu.resetKey} onOpenChange={setOpen}>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      {open ? (
        <ContextMenuContent className={menuContentClassName}>
          <ContextActionGroups groups={menu.groups} />
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}

function DropdownActionGroups({
  groups
}: {
  groups: ConversationActionEntry[][];
}): React.JSX.Element {
  return (
    <>
      {groups.map((group, groupIndex) => (
        <Fragment key={groupIndex}>
          {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
          {group.map((entry) => (
            // onClick/onPointerUp mirror onSelect so the action survives
            // workbench dead clicks (pointerup arrives but the click event
            // is swallowed); the shared runner's pending ref dedups the
            // overlapping events of one gesture.
            <DropdownMenuItem
              key={entry.id}
              disabled={entry.disabled}
              onClick={() => {
                if (!entry.disabled) {
                  entry.onSelect();
                }
              }}
              onPointerUp={(event) => {
                if (event.button === 0 && !entry.disabled) {
                  entry.onSelect();
                }
              }}
              onSelect={entry.onSelect}
            >
              {entry.icon}
              <span>{entry.label}</span>
            </DropdownMenuItem>
          ))}
        </Fragment>
      ))}
    </>
  );
}

function ContextActionGroups({
  groups
}: {
  groups: ConversationActionEntry[][];
}): React.JSX.Element {
  return (
    <>
      {groups.map((group, groupIndex) => (
        <Fragment key={groupIndex}>
          {groupIndex > 0 ? <ContextMenuSeparator /> : null}
          {group.map((entry) => (
            // Same dead-click fallbacks as DropdownActionGroups.
            <ContextMenuItem
              key={entry.id}
              disabled={entry.disabled}
              onClick={() => {
                if (!entry.disabled) {
                  entry.onSelect();
                }
              }}
              onPointerUp={(event) => {
                if (event.button === 0 && !entry.disabled) {
                  entry.onSelect();
                }
              }}
              onSelect={entry.onSelect}
            >
              {entry.icon}
              <span>{entry.label}</span>
            </ContextMenuItem>
          ))}
        </Fragment>
      ))}
    </>
  );
}
