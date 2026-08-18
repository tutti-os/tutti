import { Button, Spinner } from "@tutti-os/ui-system/components";
import { useSnapshot } from "valtio";

import type { ConnectorMarketI18nRuntime } from "../../i18n/connectorMarketI18n.ts";
import { useConnectorMarketServices } from "../ConnectorMarketServicesContext.tsx";
import { ConnectorCard } from "./ConnectorCard.tsx";
import { resolveConnectorCategoryTitle } from "./connectorCategoryTitle.ts";

export function ConnectorCatalog() {
  const { i18n, locale, market, view } = useConnectorMarketServices();
  const snapshot = useSnapshot(view.dataStore);

  if (snapshot.status === "loading") {
    return (
      <div className="flex min-h-48 items-center justify-center gap-2 text-[13px] text-[var(--text-secondary)]">
        <Spinner size={16} />
        {i18n.t("loading")}
      </div>
    );
  }
  if (snapshot.status === "error") {
    const error = snapshot.catalogError ?? {
      kind: "unknown" as const,
      retryable: false
    };
    const copy = catalogErrorCopy(error.kind, i18n);
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-[var(--border-1)] bg-[var(--transparency-block)] text-center">
        <div>
          <p className="m-0 text-[13px] font-medium text-[var(--text-primary)]">
            {copy.title}
          </p>
          <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">
            {copy.description}
          </p>
        </div>
        {error.retryable ? (
          <Button
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => void market.reload().catch(() => undefined)}
          >
            {i18n.t("actionRetry")}
          </Button>
        ) : null}
      </div>
    );
  }

  if (snapshot.sections.length === 0) {
    return (
      <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-[var(--border-1)] text-[13px] text-[var(--text-tertiary)]">
        {i18n.t("catalogEmpty")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" aria-label={i18n.t("catalogSection")}>
      {snapshot.sections.map((section) => (
        <section
          key={section.id}
          aria-label={resolveConnectorCategoryTitle({
            sectionId: section.id,
            ...(section.displayNameZh === undefined
              ? {}
              : { displayNameZh: section.displayNameZh }),
            ...(section.displayNameEn === undefined
              ? {}
              : { displayNameEn: section.displayNameEn }),
            locale,
            i18n
          })}
        >
          <h3 className="mb-3 mt-0 text-[13px] font-semibold text-[var(--text-secondary)]">
            {resolveConnectorCategoryTitle({
              sectionId: section.id,
              ...(section.displayNameZh === undefined
                ? {}
                : { displayNameZh: section.displayNameZh }),
              ...(section.displayNameEn === undefined
                ? {}
                : { displayNameEn: section.displayNameEn }),
              locale,
              i18n
            })}
          </h3>
          <div className="grid grid-cols-2 gap-3 max-[760px]:grid-cols-1">
            {section.connectorKeys.map((connectorKey) => (
              <ConnectorCard key={connectorKey} connectorKey={connectorKey} />
            ))}
          </div>
          {section.loading && section.connectorKeys.length === 0 ? (
            <div className="flex min-h-20 items-center justify-center gap-2 text-[12px] text-[var(--text-tertiary)]">
              <Spinner size={14} />
              {i18n.t("loading")}
            </div>
          ) : null}
          {section.error ? (
            <div className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-lg border border-[var(--border-1)] text-[12px] text-[var(--text-tertiary)]">
              <span>{i18n.t("sectionLoadError")}</span>
              <Button
                size="sm"
                type="button"
                variant="secondary"
                disabled={section.loading}
                onClick={() =>
                  void market.loadMore(section.id).catch(() => undefined)
                }
              >
                {i18n.t("actionRetry")}
              </Button>
            </div>
          ) : null}
          {section.hasMore ? (
            <div className="mt-3 flex justify-center">
              <Button
                size="sm"
                type="button"
                variant="secondary"
                disabled={section.loading}
                onClick={() =>
                  void market.loadMore(section.id).catch(() => undefined)
                }
              >
                {section.loading ? <Spinner size={14} /> : null}
                {i18n.t("loadMore")}
              </Button>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function catalogErrorCopy(
  kind: "invalid_data" | "unavailable" | "unknown",
  i18n: ConnectorMarketI18nRuntime
): { title: string; description: string } {
  switch (kind) {
    case "invalid_data":
      return {
        title: i18n.t("catalogInvalidDataTitle"),
        description: i18n.t("catalogInvalidDataDescription")
      };
    case "unavailable":
      return {
        title: i18n.t("catalogUnavailableTitle"),
        description: i18n.t("catalogUnavailableDescription")
      };
    default:
      return {
        title: i18n.t("catalogError"),
        description: i18n.t("catalogErrorDescription")
      };
  }
}
