const packageJson = require("../package.json");

const signer = process.env.TSH_CERTUM_ELECTRON_BUILDER_SIGNER?.trim();
const publisher = process.env.TSH_WINDOWS_EXPECTED_PUBLISHER?.trim();

if (!signer) throw new Error("TSH_CERTUM_ELECTRON_BUILDER_SIGNER is required");
if (!publisher) throw new Error("TSH_WINDOWS_EXPECTED_PUBLISHER is required");

module.exports = {
  ...packageJson.build,
  win: {
    ...packageJson.build.win,
    signtoolOptions: {
      ...(packageJson.build.win.signtoolOptions ?? {}),
      publisherName: publisher,
      sign: signer,
      signingHashAlgorithms: ["sha256"]
    }
  }
};
