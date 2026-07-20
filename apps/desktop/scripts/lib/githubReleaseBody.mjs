const GITHUB_RELEASE_BODY_MAX_LENGTH = 125_000;
const RELEASE_NOTES_TRUNCATION_NOTICE =
  "> Additional generated release-note entries were omitted to stay within GitHub's 125,000-character limit.";

function composeReleaseBody({
  existingBody,
  leadingSections,
  trailingSections,
  truncated
}) {
  const sections = [
    ...leadingSections,
    existingBody,
    ...(truncated ? [RELEASE_NOTES_TRUNCATION_NOTICE] : []),
    ...trailingSections
  ]
    .map((section) => section.trim())
    .filter(Boolean);

  return `${sections.join("\n\n")}\n`;
}

function truncateAtLineBoundary(body, maxLength) {
  if (maxLength <= 0) {
    return "";
  }

  const candidate = body.slice(0, maxLength).trimEnd();
  if (candidate.length === body.trimEnd().length) {
    return candidate;
  }

  const lastLineBreak = candidate.lastIndexOf("\n");
  return lastLineBreak === -1
    ? ""
    : candidate.slice(0, lastLineBreak).trimEnd();
}

function buildLimitedGithubReleaseBody({
  existingBody,
  leadingSections = [],
  maxLength = GITHUB_RELEASE_BODY_MAX_LENGTH,
  trailingSections = []
}) {
  const normalizedExistingBody = existingBody.trim();
  const fullBody = composeReleaseBody({
    existingBody: normalizedExistingBody,
    leadingSections,
    trailingSections,
    truncated: false
  });
  if (fullBody.length <= maxLength) {
    return fullBody;
  }

  const fixedBody = composeReleaseBody({
    existingBody: "",
    leadingSections,
    trailingSections,
    truncated: true
  });
  if (fixedBody.length > maxLength) {
    throw new Error(
      `Managed GitHub Release sections exceed the ${maxLength}-character limit`
    );
  }

  const retainedExistingBody = truncateAtLineBoundary(
    normalizedExistingBody,
    maxLength - fixedBody.length - 2
  );
  const limitedBody = composeReleaseBody({
    existingBody: retainedExistingBody,
    leadingSections,
    trailingSections,
    truncated: true
  });

  if (limitedBody.length > maxLength) {
    throw new Error(
      `GitHub Release body exceeds the ${maxLength}-character limit after truncation`
    );
  }
  return limitedBody;
}

export {
  GITHUB_RELEASE_BODY_MAX_LENGTH,
  RELEASE_NOTES_TRUNCATION_NOTICE,
  buildLimitedGithubReleaseBody,
  truncateAtLineBoundary
};
