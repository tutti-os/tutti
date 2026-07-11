import { tuttiExternalStable26ConformanceCases } from "./cases.ts";
import { tuttiExternalStable26ConformanceProfile } from "./profile.ts";
import type {
  TuttiExternalConformanceCase,
  TuttiExternalConformanceController,
  TuttiExternalConformanceDriver
} from "./types.ts";

export function createTuttiExternalConformanceController(
  driver: TuttiExternalConformanceDriver
): TuttiExternalConformanceController {
  async function runCase(
    conformanceCase: TuttiExternalConformanceCase
  ): Promise<void> {
    const host = await driver.createHost();
    try {
      await conformanceCase.run(host);
    } finally {
      await host.dispose();
    }
  }

  return Object.freeze({
    cases: tuttiExternalStable26ConformanceCases,
    profile: tuttiExternalStable26ConformanceProfile,
    runCase,
    async runAll() {
      for (const conformanceCase of tuttiExternalStable26ConformanceCases) {
        await runCase(conformanceCase);
      }
    }
  });
}
