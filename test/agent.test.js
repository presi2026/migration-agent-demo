
const test = require("node:test");
const assert = require("node:assert/strict");

const { createMigrationPlan } = require("../src/agent");

test("creates a migration plan awaiting approval", () => {
  const plan = createMigrationPlan({
    repository: "example/sample-app",
    sourceLanguage: "Python",
    targetLanguage: "JavaScript",
  });

  assert.equal(plan.repository, "example/sample-app");
  assert.equal(plan.sourceLanguage, "Python");
  assert.equal(plan.targetLanguage, "JavaScript");
  assert.equal(plan.status, "awaiting_approval");
  assert.equal(plan.changesAllowed, false);
  assert.ok(Array.isArray(plan.steps));
  assert.ok(plan.steps.length > 0);
});

test("preserves the requested migration scope", () => {
  const scope = ["src/main.py", "tests/test_main.py"];

  const plan = createMigrationPlan({
    repository: "example/sample-app",
    sourceLanguage: "Python",
    targetLanguage: "JavaScript",
    scope,
  });

  assert.deepEqual(plan.scope, scope);
});

test("rejects an invalid repository format", () => {
  assert.throws(
    () =>
      createMigrationPlan({
        repository: "invalid-repository",
        sourceLanguage: "Python",
        targetLanguage: "JavaScript",
      }),
    /owner\/repository/
  );
});

test("rejects missing source or target languages", () => {
  assert.throws(
    () =>
      createMigrationPlan({
        repository: "example/sample-app",
        sourceLanguage: "",
        targetLanguage: "JavaScript",
      }),
    /Source and target languages are required/
  );

  assert.throws(
    () =>
      createMigrationPlan({
        repository: "example/sample-app",
        sourceLanguage: "Python",
        targetLanguage: "",
      }),
    /Source and target languages are required/
  );
});