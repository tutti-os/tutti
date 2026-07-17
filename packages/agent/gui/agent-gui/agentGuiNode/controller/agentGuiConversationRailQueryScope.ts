export function userProjectCollectionKey(
  projects: readonly { id: string }[]
): string {
  return JSON.stringify(
    projects
      .map((project) => project.id.trim())
      .filter((projectId) => projectId.length > 0)
      .sort((left, right) => left.localeCompare(right))
  );
}
