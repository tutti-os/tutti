import type { ConnectorMarketI18nRuntime } from "../i18n/connectorMarketI18n.ts";
import type { ConnectorDetailFieldView } from "../../application/services/view/connectorMarketViewTypes.ts";

export function connectorDetailLabel(
  id: ConnectorDetailFieldView["id"],
  i18n: ConnectorMarketI18nRuntime
): string {
  const keys = {
    authorization: "detailAuthorization",
    compatibility: "detailCompatibility",
    implementation: "detailImplementation",
    releaseStatus: "detailReleaseStatus",
    runtime: "detailRuntime",
    transport: "detailTransport",
    version: "detailVersion"
  } as const;
  return i18n.t(keys[id]);
}
