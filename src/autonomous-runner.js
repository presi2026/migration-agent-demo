"use strict";

const SOURCE_EXTENSIONS = {
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  python: [".py"],
  java: [".java"],
  csharp: [".cs"],
  "c#": [".cs"],
  go: [".go"],
  rust: [".rs"],
  php: [".php"],
  ruby: [".rb"],
  kotlin: [".kt", ".kts"],
  swift: [".swift"],
};

const IGNORED_PATH_PARTS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
]);

const MAX_FILES = 50;
const MAX_SOURCE_BYTES = 200_000;
const MAX_REPAIR_ATTEMPTS = 2;

function normalizeLanguage(language) {
  return String(language || "").trim().toLowerCase();
}

function isEligiblePath(filePath, sourceLanguage) {
  if (
    typeof filePath !== "string" ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.includes("\0")
  ) {
    return false;
  }

  const parts = filePath.split("/");

  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        IGNORED_PATH_PARTS.has(part)
    )
  ) {
    return false;
  }

  const extensions =
    SOURCE_EXTENSIONS[normalizeLanguage(sourceLanguage)];

  if (!extensions) {
    return false;
  }

  const lowerPath = filePath.toLowerCase();

  return extensions.some((extension) =>
    lowerPath.endsWith(extension)
  );
}

function normalizeScope(files) {
  if (!Array.isArray(files)) {
    throw new Error("Migration scope must be an array.");
  }

  return files.map((file) => {
    const filePath =
      typeof file === "string" ? file : file?.filePath;

    if (
      typeof filePath !== "string" ||
      !filePath.trim() ||
      filePath.startsWith("/") ||
      filePath.includes("\\") ||
      filePath.split("/").some(
        (part) => !part || part === "." || part === ".."
      )
    ) {
      throw new Error("Migration scope contains an invalid file path.");
    }

    return filePath;
  });
}

class AutonomousRunner {
  constructor({
    engine,
    listFiles,
    readFile,
    generateProposal,
    validate,
    publish,
    maxFiles = MAX_FILES,
    maxRepairAttempts = MAX_REPAIR_ATTEMPTS,
  }) {
    if (!engine) {
      throw new Error("A migration job engine is required.");
    }

    for (const [name, callback] of Object.entries({
      listFiles,
      readFile,
      generateProposal,
      validate,
      publish,
    })) {
      if (typeof callback !== "function") {
        throw new Error(`${name} must be a function.`);
      }
    }

    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 100) {
      throw new Error("maxFiles must be between 1 and 100.");
    }

    if (
      !Number.isInteger(maxRepairAttempts) ||
      maxRepairAttempts < 0 ||
      maxRepairAttempts > 3
    ) {
      throw new Error(
        "maxRepairAttempts must be between 0 and 3."
      );
    }

    this.engine = engine;
    this.listFiles = listFiles;
    this.readFile = readFile;
    this.generateProposal = generateProposal;
    this.validate = validate;
    this.publish = publish;
    this.maxFiles = maxFiles;
    this.maxRepairAttempts = maxRepairAttempts;
    this.cancelled = new Set();
    this.active = new Set();
  }

  cancel(jobId) {
    this.cancelled.add(jobId);
  }

  checkCancelled(jobId) {
    if (this.cancelled.has(jobId)) {
      throw new Error("Migration cancelled.");
    }

    const job = this.engine.getJob(jobId);

    if (!job) {
      throw new Error("Migration job not found.");
    }

    if (job.status !== "running") {
      throw new Error(
        `Migration is no longer running (status: ${job.status}).`
      );
    }

    return job;
  }

  async execute(jobId) {
    if (this.active.has(jobId)) {
      throw new Error("This migration job is already executing.");
    }

    this.active.add(jobId);

    try {
      return await this.run(jobId);
    } finally {
      this.active.delete(jobId);
      this.cancelled.delete(jobId);
    }
  }

  async run(jobId) {
    try {
      let job = this.checkCancelled(jobId);

      this.engine.updateProgress(jobId, 5);

      const requestedScope = normalizeScope(job.files || []);
      const discovered = await this.listFiles(job);

      this.checkCancelled(jobId);

      if (!Array.isArray(discovered)) {
        throw new Error("Repository discovery returned invalid data.");
      }

      const discoveredPaths = new Set(
        discovered
          .filter((file) => file && file.type !== "tree")
          .map((file) =>
            typeof file === "string" ? file : file.path
          )
          .filter((filePath) =>
            isEligiblePath(filePath, job.sourceLanguage)
          )
      );

      let selectedPaths;

      if (requestedScope.length > 0) {
        selectedPaths = [...new Set(requestedScope)];

        const missing = selectedPaths.filter(
          (filePath) => !discoveredPaths.has(filePath)
        );

        if (missing.length > 0) {
          throw new Error(
            "Requested files are missing or do not match the source language: " +
              missing.join(", ")
          );
        }
      } else {
        selectedPaths = [...discoveredPaths];
      }

      if (selectedPaths.length === 0) {
        throw new Error(
          "No eligible source files were found. Specify files explicitly or check the source language."
        );
      }

      if (selectedPaths.length > this.maxFiles) {
        throw new Error(
          `Migration contains ${selectedPaths.length} files; the limit is ${this.maxFiles}. Narrow the scope before retrying.`
        );
      }

      const proposals = [];

      for (let index = 0; index < selectedPaths.length; index += 1) {
        this.checkCancelled(jobId);

        const filePath = selectedPaths[index];
        const source = await this.readFile(job, filePath);

        if (
          !source ||
          typeof source.content !== "string"
        ) {
          throw new Error(
            `Unable to read source file: ${filePath}`
          );
        }

        if (
          Buffer.byteLength(source.content, "utf8") >
          MAX_SOURCE_BYTES
        ) {
          throw new Error(
            `Source file exceeds the ${MAX_SOURCE_BYTES}-byte limit: ${filePath}`
          );
        }

        let proposal = await this.generateProposal({
          sourceLanguage: job.sourceLanguage,
          targetLanguage: job.targetLanguage,
          filePath,
          sourceCode: source.content,
        });

        if (
          typeof proposal !== "string" ||
          !proposal.trim()
        ) {
          throw new Error(
            `AI returned an empty proposal for ${filePath}.`
          );
        }

        let validation = await this.validate({
          job,
          filePath,
          sourceCode: source.content,
          proposal,
        });

        let repairAttempts = 0;

        while (
          !validation?.success &&
          repairAttempts < this.maxRepairAttempts
        ) {
          this.checkCancelled(jobId);

          repairAttempts += 1;

          proposal = await this.generateProposal({
            sourceLanguage: job.sourceLanguage,
            targetLanguage: job.targetLanguage,
            filePath,
            sourceCode: source.content,
            previousProposal: proposal,
            validationErrors: validation?.errors || [],
            repairAttempt: repairAttempts,
          });

          if (
            typeof proposal !== "string" ||
            !proposal.trim()
          ) {
            throw new Error(
              `AI returned an empty repair for ${filePath}.`
            );
          }

          validation = await this.validate({
            job,
            filePath,
            sourceCode: source.content,
            proposal,
          });
        }

        proposals.push({
          filePath,
          sourceSha: source.sha || null,
          proposal,
          validation: {
            success: Boolean(validation?.success),
            errors: Array.isArray(validation?.errors)
              ? validation.errors
              : [],
            checks: Array.isArray(validation?.checks)
              ? validation.checks
              : [],
          },
          repairAttempts,
        });

        this.engine.updateJobDetails(jobId, {
          proposals: structuredClone(proposals),
        });

        const progress = 10 + Math.floor(
          ((index + 1) / selectedPaths.length) * 65
        );

        this.engine.updateProgress(
          jobId,
          Math.min(progress, 75)
        );
      }

      this.checkCancelled(jobId);

      const failed = proposals.filter(
        (proposal) => !proposal.validation.success
      );

      if (failed.length > 0) {
        throw new Error(
          `Validation failed for ${failed.length} file(s): ` +
            failed.map((item) => item.filePath).join(", ")
        );
      }

      this.engine.updateProgress(jobId, 80);

      const publication = await this.publish({
        job,
        proposals,
      });

      this.checkCancelled(jobId);

      if (
        !publication ||
        typeof publication.branch !== "string" ||
        !publication.branch
      ) {
        throw new Error(
          "Publication did not return a valid branch."
        );
      }

      const details = {
        branch: publication.branch,
        changesApplied: true,
      };

      if (publication.pullRequest) {
        details.pullRequest = publication.pullRequest;
      }

      this.engine.updateJobDetails(jobId, details);

      this.engine.updateProgress(jobId, 95);

      job = this.engine.transitionJob(jobId, "completed");

      return {
        success: true,
        job,
        filesMigrated: proposals.length,
        validationPassed: true,
      };
    } catch (error) {
      const current = this.engine.getJob(jobId);

      if (current && current.status === "running") {
        if (
          this.cancelled.has(jobId) &&
          error.message === "Migration cancelled."
        ) {
          this.engine.transitionJob(jobId, "cancelled");
        } else {
          this.engine.transitionJob(jobId, "failed", {
            error:
              error instanceof Error
                ? error.message
                : "Autonomous migration failed.",
          });
        }
      }

      throw error;
    }
  }
}

module.exports = {
  AutonomousRunner,
  isEligiblePath,
  normalizeScope,
};
