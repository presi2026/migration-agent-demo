
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MigrationEngine } = require("../src/migration-engine");

function createTestEnvironment() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "migration-agent-test-")
  );

  const storageFile = path.join(directory, "migration-jobs.json");
  const engine = new MigrationEngine({ storageFile });

  return {
    engine,
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function createTestJob(engine) {
  return engine.createJob({
    repository: "example/sample-app",
    sourceLanguage: "Python",
    targetLanguage: "JavaScript",
  });
}

test("creates a queued migration job", (t) => {
  const env = createTestEnvironment();
  t.after(() => env.cleanup());

  const job = createTestJob(env.engine);

  assert.ok(job.id);
  assert.equal(job.status, "queued");
  assert.equal(job.progress, 0);
  assert.equal(job.changesApplied, false);
});

test("retrieves a job by ID", (t) => {
  const env = createTestEnvironment();
  t.after(() => env.cleanup());

  const job = createTestJob(env.engine);

  assert.equal(env.engine.getJob(job.id).id, job.id);
  assert.equal(env.engine.getJob("unknown-id"), null);
});

test("lists migration jobs", (t) => {
  const env = createTestEnvironment();
  t.after(() => env.cleanup());

  createTestJob(env.engine);
  createTestJob(env.engine);

  assert.equal(env.engine.listJobs().length, 2);
});

test("tracks job transitions and progress", (t) => {
  const env = createTestEnvironment();
  t.after(() => env.cleanup());

  const job = createTestJob(env.engine);

  env.engine.transitionJob(job.id, "running");
  env.engine.updateProgress(job.id, 50);

  assert.equal(env.engine.getJob(job.id).status, "running");
  assert.equal(env.engine.getJob(job.id).progress, 50);

  env.engine.transitionJob(job.id, "completed");

  assert.equal(env.engine.getJob(job.id).status, "completed");
  assert.equal(env.engine.getJob(job.id).progress, 100);
});

test("rejects invalid state transitions", (t) => {
  const env = createTestEnvironment();
  t.after(() => env.cleanup());

  const job = createTestJob(env.engine);

  assert.throws(
    () => env.engine.transitionJob(job.id, "completed"),
    /Invalid migration job transition/
  );
});

test("records job failures", (t) => {
  const env = createTestEnvironment();
  t.after(() => env.cleanup());

  const job = createTestJob(env.engine);

  env.engine.transitionJob(job.id, "running");

  env.engine.transitionJob(job.id, "failed", {
    error: "Validation failed.",
  });

  assert.equal(env.engine.getJob(job.id).status, "failed");
  assert.equal(env.engine.getJob(job.id).error, "Validation failed.");
});

test("rejects invalid progress", (t) => {
  const env = createTestEnvironment();
  t.after(() => env.cleanup());

  const job = createTestJob(env.engine);

  env.engine.transitionJob(job.id, "running");

  assert.throws(
    () => env.engine.updateProgress(job.id, 101),
    /Progress must be an integer/
  );

  assert.throws(
    () => env.engine.updateProgress(job.id, 50.5),
    /Progress must be an integer/
  );
});

test("rejects invalid repository and language inputs", (t) => {
  const env = createTestEnvironment();
  t.after(() => env.cleanup());

  assert.throws(
    () =>
      env.engine.createJob({
        repository: "invalid-repository",
        sourceLanguage: "Python",
        targetLanguage: "JavaScript",
      }),
    /owner\/repository/
  );

  assert.throws(
    () =>
      env.engine.createJob({
        repository: "example/sample-app",
        sourceLanguage: "",
        targetLanguage: "JavaScript",
      }),
    /Source and target languages are required/
  );
});