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

export function packagePeerContractViolations(packageName, manifest) {
  const requiredPeers = requiredTiptapPeers.get(packageName);
  if (!requiredPeers) return [];

  const dependencies = manifest.dependencies ?? {};
  const devDependencies = manifest.devDependencies ?? {};
  const peerDependencies = manifest.peerDependencies ?? {};
  const violations = [];

  for (const name of requiredPeers) {
    if (Object.hasOwn(dependencies, name)) {
      violations.push(`${name} must be a peer dependency`);
    }
    if (!Object.hasOwn(peerDependencies, name)) {
      violations.push(`${name} is missing from peerDependencies`);
    } else if (devDependencies[name] !== peerDependencies[name]) {
      violations.push(`${name} must use the same peer and dev range`);
    }
  }

  return violations;
}
