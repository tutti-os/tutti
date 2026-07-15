const gitRepositoryEnvironmentVariables = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE"
]);

export function createIsolatedGitEnvironment(
  fixtureRoot,
  inheritedEnvironment = process.env
) {
  const env = { ...inheritedEnvironment };
  for (const name of Object.keys(env)) {
    const normalizedName = name.toUpperCase();
    if (
      gitRepositoryEnvironmentVariables.has(normalizedName) ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(normalizedName)
    ) {
      delete env[name];
    }
  }
  env.GIT_CEILING_DIRECTORIES = fixtureRoot;
  return env;
}
