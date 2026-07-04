import type { AnalyticsReporterDependencies } from "../baseReporter.ts";

export class AppPageviewReporter {
  private readonly dependencies: AnalyticsReporterDependencies;
  private readonly eventName = "app.pageview";

  constructor(dependencies: AnalyticsReporterDependencies) {
    this.dependencies = dependencies;
  }

  async report(): Promise<void> {
    await this.dependencies.reporterService.trackEvents([
      {
        clientTS: this.dependencies.now?.() ?? Date.now(),
        name: this.eventName
      }
    ]);
  }
}
