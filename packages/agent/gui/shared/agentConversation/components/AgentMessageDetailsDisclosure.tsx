import { useState, type JSX } from "react";
import { ChevronRight } from "lucide-react";
import { translate } from "../../../i18n/index";
import { CollapsibleReveal } from "./CollapsibleReveal";

export function AgentMessageDetailsDisclosure({
  detail,
  className = "",
  label
}: {
  detail: string;
  className?: string;
  label?: string;
}): JSX.Element {
  "use memo";
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`${className} text-[11px] text-[var(--state-danger)]`}>
      <button
        type="button"
        className="inline-flex w-fit max-w-full min-w-0 cursor-pointer select-none items-center gap-1.5 border-0 bg-transparent p-0 text-left font-[inherit] text-[inherit] transition-colors duration-150 hover:text-[var(--state-danger-hover)]"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {label ?? translate("agentHost.agentGui.visibleErrorDetails")}
        <ChevronRight
          size={12}
          strokeWidth={2.2}
          aria-hidden="true"
          className="shrink-0 text-[var(--state-danger)]"
          style={{
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transformOrigin: "center",
            transition: "transform 200ms cubic-bezier(0.22, 1.18, 0.36, 1)",
            willChange: "transform"
          }}
        />
      </button>
      <CollapsibleReveal expanded={expanded} preMountOnIdle>
        <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[6px] bg-[var(--on-danger)] px-3 py-2 font-[var(--tsh-font-mono)] text-[11px] leading-5 text-[var(--state-danger)]">
          {detail}
        </pre>
      </CollapsibleReveal>
    </div>
  );
}
