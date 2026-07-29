import {
  BaseAnalyticsReporter as SharedBaseAnalyticsReporter,
  toAnalyticsProtocolParams,
  type AnalyticsReporterDependencies,
  type AnalyticsReporterParams,
  type AnalyticsReporterParamValue
} from "@tutti-os/analytics";
import type { ReporterEventParams } from "../services/reporterService.interface";
import { agentAnalyticsSuccessFields } from "../../workspace-agent/agentAnalyticsError.ts";

export abstract class BaseAnalyticsReporter<
  TParams extends AnalyticsReporterParams
> extends SharedBaseAnalyticsReporter<TParams> {
  protected override toProtocolParams(): ReporterEventParams {
    if (isAgentAnalyticsEvent(this.eventName)) {
      return {
        ...toAnalyticsProtocolParams(agentAnalyticsSuccessFields),
        ...super.toProtocolParams()
      };
    }
    return super.toProtocolParams();
  }
}

export type {
  AnalyticsReporterDependencies,
  AnalyticsReporterParams,
  AnalyticsReporterParamValue
};

function isAgentAnalyticsEvent(eventName: string): boolean {
  return (
    eventName.startsWith("agent.") || eventName === "error.agent_session_failed"
  );
}
