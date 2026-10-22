"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MigrationEngine } = require("../src/migration-engine");
const {
  AutonomousRunner,
  isEligiblePath,
} = require("../src/autonomous-runner");

function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "autonomous-runner-test-")
  );

  t.after(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const engine = new MigrationEngine({
    storageFile: path.join(directory, "jobs.json"),
  });

  const job = engine.createJob({
    repository: "example/sample-app",
    sourceLanguage: "Python",
    targetLanguage: "JavaScript",
    files: ["src/main.py"],
  });

  engine.transitionJob(job.id, "running");

  const runner = new AutonomousRunner({
    engine,
    listFiles: async () => ["src/main.py", "README.md"],
    readFile: async () => ({
      content: 'print("hello")',
      sha: "source-sha",
    }),
    generateProposal: async () =>
      'console.log("hello");',
    validate: async () => ({
      success: true,
      checks: ["syntax"],
      errors: [],
    }),
    publish: async () => ({
      branch: "migration/test-job",
      pullRequest: "https://github.com/example/sample-app/pull/1",
    }),
    ...overrides,
  });

  return { engine, job, runner };
}

test("identifies eligible source files", () => {
  assert.equal(
    isEligiblePath("src/main.py", "Python"),
    true
  );

  assert.equal(
    isEligiblePath("node_modules/example/index.py", "Python"),
    false
  );

  assert.equal(
    isEligiblePath("../outside.py", "Python"),
    false
  );

  assert.equal(
    isEligiblePath("src/main.py", "Unknown"),
    false
  );
});

test("executes a migration and records its result", async (t) => {
  const { engine, job, runner } = setup(t);

  const result = await runner.execute(job.id);
  const saved = engine.getJob(job.id);

  assert.equal(result.success, true);
  assert.equal(saved.status, "completed");
  assert.equal(saved.progress, 100);
  assert.equal(saved.changesApplied, true);
  assert.equal(saved.branch, "migration/test-job");
  assert.equal(saved.proposals.length, 1);
  assert.equal(saved.proposals[0].validation.success, true);
});

test("repairs a proposal after validation fails", async (t) => {
  let generations = 0;

  const { engine, job, runner } = setup(t, {
    generateProposal: async () => {
      generations += 1;
      return generations === 1
        ? "invalid proposal"
        : 'console.log("repaired");';
    },
    validate: async ({ proposal }) => ({
      success: proposal.includes("repaired"),
      errors: proposal.includes("repaired")
        ? []
        : ["Validation failed"],
      checks: ["mock-validation"],
    }),
  });

  await runner.execute(job.id);

  const saved = engine.getJob(job.id);

  assert.equal(generations, 2);
  assert.equal(saved.status, "completed");
  assert.equal(saved.proposals[0].repairAttempts, 1);
});

test("marks a job failed when validation cannot be repaired", async (t) => {
  const { engine, job, runner } = setup(t, {
    maxRepairAttempts: 0,
    validate: async () => ({
      success: false,
      errors: ["Syntax validation failed"],
      checks: ["syntax"],
    }),
  });

  await assert.rejects(
    runner.execute(job.id),
    /Validation failed/
  );

  const saved = engine.getJob(job.id);

  assert.equal(saved.status, "failed");
  assert.match(saved.error, /Validation failed/);
  assert.equal(saved.changesApplied, false);
});

test("does not publish when validation fails", async (t) => {
  let published = false;

  const { engine, job, runner } = setup(t, {
    maxRepairAttempts: 0,
    validate: async () => ({
      success: false,
      errors: ["Build failed"],
      checks: ["build"],
    }),
    publish: async () => {
      published = true;
      return { branch: "unexpected" };
    },
  });

  await assert.rejects(runner.execute(job.id));

  assert.equal(published, false);
  assert.equal(engine.getJob(job.id).status, "failed");
});
