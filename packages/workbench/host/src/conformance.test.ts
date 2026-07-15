import test from "node:test";

import { createWorkbenchHostConformanceCases } from "./conformance/index.ts";

for (const conformanceCase of createWorkbenchHostConformanceCases()) {
  test(conformanceCase.name, conformanceCase.run);
}

test("conformance accepts product partition and capability fixtures", async () => {
  const cases = createWorkbenchHostConformanceCases({
    capabilityProfile: {
      capabilityFactories: [
        {
          create: () => ({ id: "room-capability" }),
          id: "room-factory",
          order: 10
        }
      ]
    },
    createPartition: ({ principalId, scopeId }) => ({
      ...(principalId ? { principal: { id: principalId } } : {}),
      scope: { id: scopeId, kind: "room" }
    }),
    expectedContributionIds: ["room-capability"]
  });

  for (const conformanceCase of cases) {
    await conformanceCase.run();
  }
});
