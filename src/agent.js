
function createMigrationPlan({ repository, sourceLanguage, targetLanguage, scope = [] }) {
  if (!repository || !repository.includes("/")) {
    throw new Error("Repository must use owner/repository format.");
  }

  if (!sourceLanguage || !targetLanguage) {
    throw new Error("Source and target languages are required.");
  }

  return {
    repository,
    sourceLanguage,
    targetLanguage,
    scope,
    status: "awaiting_approval",
    steps: [
      "Inspect the repository and identify relevant files.",
      `Analyze files written in ${sourceLanguage}.`,
      `Prepare a proposed ${sourceLanguage}-to-${targetLanguage} migration.`,
      "Validate the proposed changes with available tests and checks."
    ],
    changesAllowed: false
  };
}

module.exports = { createMigrationPlan };
