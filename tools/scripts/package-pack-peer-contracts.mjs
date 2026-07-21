const requiredTiptapPeers = new Map([
  [
    "@tutti-os/agent-gui",
    [
      "@tiptap/core",
      "@tiptap/pm",
      "@tiptap/react",
      "@tiptap/starter-kit",
      "@tiptap/suggestion"
    ]
  ],
  ["@tutti-os/ui-rich-text", ["@tiptap/core", "@tiptap/react"]]
]);
const bundledTiptapDependencies = new Map([
  [
    "@tutti-os/ui-rich-text",
    [
      "@tiptap/extension-document",
      "@tiptap/extension-hard-break",
      "@tiptap/extension-paragraph",
      "@tiptap/extension-text"
    ]
  ]
]);

export function packagePeerContractViolations(packageName, manifest) {
  const requiredPeers = requiredTiptapPeers.get(packageName);
  const bundledDependencies = bundledTiptapDependencies.get(packageName) ?? [];
  if (!requiredPeers && bundledDependencies.length === 0) return [];

  const dependencies = manifest.dependencies ?? {};
  const devDependencies = manifest.devDependencies ?? {};
  const peerDependencies = manifest.peerDependencies ?? {};
  const violations = [];

  for (const name of requiredPeers ?? []) {
    if (Object.hasOwn(dependencies, name)) {
      violations.push(`${name} must be a peer dependency`);
    }
    if (!Object.hasOwn(peerDependencies, name)) {
      violations.push(`${name} is missing from peerDependencies`);
    } else if (devDependencies[name] !== peerDependencies[name]) {
      violations.push(`${name} must use the same peer and dev range`);
    }
  }

  for (const name of bundledDependencies) {
    if (Object.hasOwn(dependencies, name)) {
      violations.push(`${name} must be bundled from devDependencies`);
    }
    if (Object.hasOwn(peerDependencies, name)) {
      violations.push(`${name} must not be a consumer peer dependency`);
    }
    if (!Object.hasOwn(devDependencies, name)) {
      violations.push(`${name} is missing from devDependencies`);
    }
  }

  return violations;
}

export function externalBundledTiptapImports(packageName, source) {
  return (bundledTiptapDependencies.get(packageName) ?? []).filter(
    (name) => source.includes(`"${name}"`) || source.includes(`'${name}'`)
  );
}
