import type { JSX } from "react";
import { translate } from "../../../../../i18n/index";
import { ToolMarkdownBlock } from "../agentToolContentShared";
import {
  itemPrimaryText,
  itemSecondaryText,
  parsedItems,
  type AgentMcpNormalizedPayload
} from "./agentMcpShared";

export function renderAtlassianMcp(
  payload: AgentMcpNormalizedPayload
): JSX.Element | null {
  const items = parsedItems(payload.structured);
  if (items.length > 0) {
    return (
      <div className="workspace-agents-status-panel__detail-tool-result-list overflow-hidden rounded-[8px] border border-[var(--line-2)] bg-[var(--transparency-block)]">
        {items.map((item, index) => (
          <div
            key={`${itemPrimaryText(item) ?? "item"}::${itemSecondaryText(item) ?? ""}`}
            className={`px-3 py-2 ${index > 0 ? "border-t border-[var(--line-2)]" : ""}`}
          >
            <div className="text-[11px] font-semibold text-[var(--text-primary)]">
              {itemPrimaryText(item) ??
                translate("agentHost.agentTool.details.mcpItem", {
                  index: index + 1
                })}
            </div>
            {itemSecondaryText(item) ? (
              <div className="text-[11px] text-[var(--text-tertiary)]">
                {itemSecondaryText(item)}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    );
  }

  return payload.text ? (
    <ToolMarkdownBlock content={payload.text} collapsible />
  ) : null;
}
