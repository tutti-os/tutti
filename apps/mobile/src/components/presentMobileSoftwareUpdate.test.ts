import { updateInstallFailureDescription } from "./presentMobileSoftwareUpdate";

test("gives actionable descriptions for update failures", () => {
  expect(
    updateInstallFailureDescription("UPDATE_STORAGE_INSUFFICIENT")
  ).toContain("Free up storage");
  expect(updateInstallFailureDescription("UPDATE_CHECKSUM_FAILED")).toContain(
    "did not match"
  );
  expect(
    updateInstallFailureDescription("UPDATE_DOWNLOAD_MANAGER_FAILED")
  ).toContain("update task");
  expect(updateInstallFailureDescription("UPDATE_INSTALL_DEFERRED")).toContain(
    "Return to Tutti"
  );
  expect(updateInstallFailureDescription("UPDATE_INSTALL_CONFLICT")).toContain(
    "conflicts"
  );
  expect(
    updateInstallFailureDescription("UPDATE_INSTALL_PERMISSION_REQUIRED")
  ).toContain("Allow Tutti");
});
