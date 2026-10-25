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
    listFiles: async () => [
      "src/main.py",
      "README.md",
    ],
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
      pullRequest:
        "https://github.com/example/sample-app/pull/1",
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
    isEligiblePath(
      "node_modules/example/index.py",
      "Python"
    ),
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

test(
  "prepares a migration and waits for approval",
  async (t) => {
    const { engine, job, runner } = setup(t);

    let published = false;

    runner.publish = async () => {
      published = true;
      return { branch: "migration/test-job" };
    };

    const result = await runner.execute(job.id);
    const saved = engine.getJob(job.id);

    assert.equal(result.success, true);
    assert.equal(result.awaitingApproval, true);
    assert.equal(saved.status, "awaiting_approval");
    assert.equal(saved.progress, 80);
    assert.equal(saved.changesApplied, false);
    assert.equal(saved.branch, null);
    assert.equal(saved.proposals.length, 1);
    assert.equal(
      saved.proposals[0].validation.success,
      true
    );
    assert.equal(published, false);
  }
);

test(
  "repairs a proposal after validation fails",
  async (t) => {
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
    assert.equal(
      saved.status,
      "awaiting_approval"
    );
    assert.equal(
      saved.proposals[0].repairAttempts,
      1
    );
    assert.equal(
      saved.proposals[0].validation.success,
      true
    );
  }
);

test(
  "marks a job failed when validation cannot be repaired",
  async (t) => {
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
    assert.match(
      saved.error,
      /Validation failed/
    );
    assert.equal(saved.changesApplied, false);
  }
);

test(
  "does not publish when validation fails",
  async (t) => {
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

    await assert.rejects(
      runner.execute(job.id)
    );

    assert.equal(published, false);
    assert.equal(
      engine.getJob(job.id).status,
      "failed"
    );
  }
);

test(
  "publishes only after explicit approval",
  async (t) => {
    let publicationCalls = 0;

    const { engine, job, runner } = setup(t, {
      publish: async () => {
        publicationCalls += 1;

        return {
          branch: "migration/test-job",
          pullRequest:
            "https://github.com/example/sample-app/pull/1",
        };
      },
    });

    await runner.execute(job.id);

    assert.equal(publicationCalls, 0);
    assert.equal(
      engine.getJob(job.id).status,
      "awaiting_approval"
    );

    const result = await runner.publishApproved(
      job.id
    );

    const saved = engine.getJob(job.id);

    assert.equal(result.success, true);
    assert.equal(saved.status, "completed");
    assert.equal(saved.progress, 100);
    assert.equal(saved.changesApplied, true);
    assert.equal(
      saved.branch,
      "migration/test-job"
    );
    assert.ok(saved.approvedAt);
    assert.equal(publicationCalls, 1);
  }
);

test(
  "rejects publication for jobs without approval",
  async (t) => {
    let published = false;

    const { job, runner } = setup(t, {
      publish: async () => {
        published = true;
        return {
          branch: "migration/unexpected",
        };
      },
    });

    await assert.rejects(
      runner.publishApproved(job.id),
      /Only jobs awaiting approval/
    );

    assert.equal(published, false);
  }
);

test(
  "marks a job failed when approved publication fails",
  async (t) => {
    const { engine, job, runner } = setup(t, {
      publish: async () => {
        throw new Error("GitHub publication failed");
      },
    });

    await runner.execute(job.id);

    await assert.rejects(
      runner.publishApproved(job.id),
      /GitHub publication failed/
    );

    const saved = engine.getJob(job.id);

    assert.equal(saved.status, "failed");
    assert.match(
      saved.error,
      /GitHub publication failed/
    );
    assert.equal(saved.changesApplied, false);
  }
);
