import {
  useCallback,
  useRef,
  type MouseEvent,
  type PointerEvent,
  type ReactNode
} from "react";
import { FileText, MoreHorizontal, Pencil, AtSign } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@tutti-os/ui-system";
import type {
  AgentGuiWorkbenchSessionAction,
  AgentGuiWorkbenchSessionMenuCopy
} from "./sessionActions.ts";

const menuContentClassName =
  "w-max min-w-44 nodrag [-webkit-app-region:no-drag]";

export interface AgentGuiWorkbenchSessionMenuAdditionalAction {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
}

export interface AgentGuiWorkbenchSessionMenuProps {
  actions?: readonly AgentGuiWorkbenchSessionAction[];
  additionalActions?: readonly AgentGuiWorkbenchSessionMenuAdditionalAction[];
  copy: AgentGuiWorkbenchSessionMenuCopy;
  onAction: (action: AgentGuiWorkbenchSessionAction) => void;
}

export function AgentGuiWorkbenchSessionMenu({
  actions = ["rename", "copy-markdown", "copy-reference"],
  additionalActions = [],
  copy,
  onAction
}: AgentGuiWorkbenchSessionMenuProps): ReactNode {
  const showRename = actions.includes("rename");
  const showCopyMarkdown = actions.includes("copy-markdown");
  const showCopyReference = actions.includes("copy-reference");
  const showCopyActions = showCopyMarkdown || showCopyReference;
  const showBuiltInActions = showRename || showCopyActions;
  const pendingActionRef = useRef(false);
  const select = useCallback((onSelect: () => void) => {
    if (pendingActionRef.current) {
      return;
    }
    pendingActionRef.current = true;
    // Radix renders the menu through a React portal. Portal events still
    // bubble through the React tree, so dispatching synchronously from
    // pointerup can update/unmount header chrome while its draggable region
    // is handling the same gesture. Let the menu gesture finish first.
    window.requestAnimationFrame(() => {
      pendingActionRef.current = false;
      onSelect();
    });
  }, []);
  const actionProps = useCallback(
    (onSelect: () => void) => ({
      onClick: () => select(onSelect),
      onPointerUp: (event: PointerEvent) => {
        if (event.button === 0) {
          select(onSelect);
        }
      },
      onSelect: () => select(onSelect)
    }),
    [select]
  );
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          pendingActionRef.current = false;
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={copy.moreSessionActions}
          title={copy.moreSessionActions}
          className="agent-gui-workbench-header__icon-button agent-gui-workbench-header__session-menu-trigger"
          data-testid="agent-gui-session-menu-trigger"
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <MoreHorizontal
            aria-hidden="true"
            className="agent-gui-workbench-header__icon"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className={menuContentClassName}
        onClick={stopMousePropagation}
        onDoubleClick={stopMousePropagation}
        onPointerDown={stopPointerPropagation}
        onPointerUp={stopPointerPropagation}
        sideOffset={6}
      >
        {additionalActions.map((action) => (
          <DropdownMenuItem key={action.id} {...actionProps(action.onSelect)}>
            {action.icon}
            <span>{action.label}</span>
          </DropdownMenuItem>
        ))}
        {additionalActions.length > 0 && showBuiltInActions ? (
          <DropdownMenuSeparator />
        ) : null}
        {showRename ? (
          <DropdownMenuItem {...actionProps(() => onAction("rename"))}>
            <Pencil aria-hidden="true" />
            <span>{copy.renameSession}</span>
          </DropdownMenuItem>
        ) : null}
        {showRename && showCopyActions ? <DropdownMenuSeparator /> : null}
        {showCopyMarkdown ? (
          <DropdownMenuItem {...actionProps(() => onAction("copy-markdown"))}>
            <FileText aria-hidden="true" />
            <span>{copy.copyAsMarkdown}</span>
          </DropdownMenuItem>
        ) : null}
        {showCopyReference ? (
          <DropdownMenuItem {...actionProps(() => onAction("copy-reference"))}>
            <AtSign aria-hidden="true" />
            <span>{copy.copyAsReference}</span>
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function stopMousePropagation(event: MouseEvent): void {
  event.stopPropagation();
}

function stopPointerPropagation(event: PointerEvent): void {
  event.stopPropagation();
}
