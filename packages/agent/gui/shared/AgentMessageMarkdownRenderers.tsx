import {
  useCallback,
  useContext,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode
} from "react";
import { Check, Copy } from "lucide-react";
import { translate } from "../i18n/index";
import { cn } from "../app/renderer/lib/utils";
import type { MarkdownDomProps } from "./AgentMessageMarkdown";
import { MarkdownLinkContext } from "./agentMessageMarkdownContext";
import {
  isExplicitWorkspaceFilePath,
  isHttpUrl
} from "./agentMessageMarkdownLinks";
import {
  activateMarkdownLink,
  activateMarkdownLinkFromKey,
  activateMarkdownLinkFromPointer
} from "./agentMessageMarkdownRuntime";

export function MarkdownCode({
  node: _node,
  children,
  className,
  onLinkClick,
  ...props
}: MarkdownDomProps<"code"> & {
  onLinkClick?: (href: string) => void;
}): JSX.Element {
  "use memo";
  const isInsideLink = useContext(MarkdownLinkContext);
  const text = textFromReactNode(children).trim();
  const isLinkablePath =
    !isInsideLink &&
    onLinkClick &&
    !className &&
    (isExplicitWorkspaceFilePath(text) || isHttpUrl(text));
  if (isLinkablePath) {
    return (
      <PathLink href={text} onLinkClick={onLinkClick}>
        {children}
      </PathLink>
    );
  }
  return (
    <code {...props} className={className}>
      {children}
    </code>
  );
}

const MARKDOWN_ORDERED_LIST_STYLE: CSSProperties = {
  listStylePosition: "outside",
  margin: "12px 0 8px",
  paddingInlineStart: 34,
  paddingInlineEnd: 16
};

const MARKDOWN_UNORDERED_LIST_STYLE: CSSProperties = {
  margin: "12px 0 8px",
  paddingInlineStart: 0
};

const MARKDOWN_LIST_ITEM_STYLE: CSSProperties = {
  margin: "4px 0"
};

export function MarkdownUnorderedList({
  node: _node,
  className,
  style,
  ...props
}: MarkdownDomProps<"ul">): JSX.Element {
  "use memo";
  return (
    <ul
      {...props}
      className={cn(
        '[&_li]:relative [&_li]:list-none [&_li]:pl-[34px] [&_li::before]:absolute [&_li::before]:left-4 [&_li::before]:top-[0.78em] [&_li::before]:h-1.5 [&_li::before]:w-1.5 [&_li::before]:-translate-y-1/2 [&_li::before]:rounded-full [&_li::before]:bg-[var(--text-tertiary)] [&_li::before]:content-[""]',
        className
      )}
      style={{ ...MARKDOWN_UNORDERED_LIST_STYLE, ...style }}
    />
  );
}

export function MarkdownOrderedList({
  node: _node,
  style,
  ...props
}: MarkdownDomProps<"ol">): JSX.Element {
  "use memo";
  return (
    <ol
      {...props}
      style={{
        ...MARKDOWN_ORDERED_LIST_STYLE,
        listStyleType: "decimal",
        ...style
      }}
    />
  );
}

export function MarkdownListItem({
  node: _node,
  style,
  ...props
}: MarkdownDomProps<"li">): JSX.Element {
  "use memo";
  return <li {...props} style={{ ...MARKDOWN_LIST_ITEM_STYLE, ...style }} />;
}

export function MarkdownParagraph({
  node: _node,
  inline,
  ...props
}: MarkdownDomProps<"p"> & {
  inline: boolean;
}): JSX.Element {
  "use memo";
  if (inline) {
    return <span {...props} />;
  }
  return <p {...props} />;
}

function PathLink({
  href,
  children,
  onLinkClick
}: {
  href: string;
  children: ReactNode;
  onLinkClick: (href: string) => void;
}): JSX.Element {
  "use memo";
  return (
    <a
      className="cursor-pointer"
      data-agent-link-href={href}
      role="link"
      tabIndex={0}
      onClick={(event) => {
        activateMarkdownLink(event, href, onLinkClick);
      }}
      onPointerDown={(event) => {
        activateMarkdownLinkFromPointer(event, href, onLinkClick);
      }}
      onKeyDown={(event) => {
        activateMarkdownLinkFromKey(event, href, onLinkClick);
      }}
    >
      {children}
    </a>
  );
}

export function textFromReactNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textFromReactNode).join("");
  }
  return "";
}

export function MarkdownPre({
  children,
  ...props
}: MarkdownDomProps<"pre">): JSX.Element {
  "use memo";
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent?.trim();
    if (!text) {
      return;
    }
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
      }
      // timing: revert the "copied" affordance after the confirmation window
      copyResetRef.current = setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  return (
    <div className="group relative">
      <button
        type="button"
        data-testid="markdown-code-copy"
        className="absolute right-1.5 top-1.5 z-10 inline-flex size-5 items-center justify-center rounded-[4px] text-[var(--text-tertiary)] opacity-0 transition-opacity hover:bg-[var(--transparency-hover)] hover:text-[var(--text-secondary)] group-hover:opacity-100"
        aria-label={translate("agentHost.agentGui.copyCode")}
        title={translate("agentHost.agentGui.copyCode")}
        onClick={handleCopy}
      >
        {copied ? (
          <Check size={13} strokeWidth={2} aria-hidden="true" />
        ) : (
          <Copy size={13} strokeWidth={2} aria-hidden="true" />
        )}
      </button>
      <pre {...props} ref={preRef}>
        {children}
      </pre>
    </div>
  );
}
