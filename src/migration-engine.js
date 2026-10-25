
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ALLOWED_TRANSITIONS = {
  queued: ["running", "cancelled"],
  running: [
    "awaiting_approval",
    "completed",
    "failed",
    "cancelled",
  ],
  awaiting_approval: ["running", "cancelled"],
  failed: ["queued"],
  completed: [],
  cancelled: [],
};

const ALLOWED_JOB_FIELDS = new Set([
  "proposals",
  "approvedAt",
  "branch",
  "pullRequest",
  "changesApplied",
  "baseBranch",
]);

class MigrationEngine {
  constructor(options = {}) {
    this.jobs = new Map();

    this.storageFile =
      options.storageFile ||
      process.env.MIGRATION_JOBS_FILE ||
      path.join(__dirname, "..", "data", "migration-jobs.json");

    this.loadJobs();
  }

  loadJobs() {
    if (!fs.existsSync(this.storageFile)) {
      return;
    }

    const savedJobs = JSON.parse(
      fs.readFileSync(this.storageFile, "utf8")
    );

    if (!Array.isArray(savedJobs)) {
      throw new Error(
        "Migration job storage must contain a JSON array."
      );
    }

    let recovered = false;

    for (const job of savedJobs) {
      if (
        !job ||
        typeof job.id !== "string" ||
        typeof job.status !== "string"
      ) {
        throw new Error(
          "Migration job storage contains an invalid job."
        );
      }

      // A running job may have been interrupted by a restart.
      if (job.status === "running") {
        job.status = "failed";
        job.error =
          "Job interrupted by a server restart. Review its state before retrying.";
        job.updatedAt = new Date().toISOString();
        recovered = true;
      }

      this.jobs.set(job.id, job);
    }

    if (recovered) {
      this.saveJobs();
    }
  }

  saveJobs() {
    const directory = path.dirname(this.storageFile);

    fs.mkdirSync(directory, { recursive: true });

    const temporaryFile =
      `${this.storageFile}.${process.pid}.${crypto.randomUUID()}.tmp`;

    try {
      fs.writeFileSync(
        temporaryFile,
        JSON.stringify(
          Array.from(this.jobs.values()),
          null,
          2
        ),
        {
          encoding: "utf8",
          mode: 0o600,
        }
      );

      fs.renameSync(temporaryFile, this.storageFile);
    } finally {
      if (fs.existsSync(temporaryFile)) {
        fs.unlinkSync(temporaryFile);
      }
    }
  }

  createJob({
    repository,
    sourceLanguage,
    targetLanguage,
    files = [],
    baseBranch = "main",
  }) {
    if (
      typeof repository !== "string" ||
      !/^[^/\s]+\/[^/\s]+$/.test(repository)
    ) {
      throw new Error(
        "Repository must use owner/repository format."
      );
    }

    if (
      typeof sourceLanguage !== "string" ||
      !sourceLanguage.trim() ||
      typeof targetLanguage !== "string" ||
      !targetLanguage.trim()
    ) {
      throw new Error(
        "Source and target languages are required."
      );
    }

    if (!Array.isArray(files)) {
      throw new Error("Files must be an array.");
    }

    if (
      typeof baseBranch !== "string" ||
      !baseBranch.trim() ||
      baseBranch.startsWith("-") ||
      baseBranch.includes("..")
    ) {
      throw new Error("A valid base branch is required.");
    }

    const now = new Date().toISOString();

    const job = {
      id: crypto.randomUUID(),
      repository,
      sourceLanguage: sourceLanguage.trim(),
      targetLanguage: targetLanguage.trim(),
      files: structuredClone(files),
      baseBranch,
      status: "queued",
      progress: 0,
      createdAt: now,
      updatedAt: now,
      error: null,
      changesApplied: false,
      proposals: [],
      approvedAt: null,
      branch: null,
      pullRequest: null,
    };

    this.jobs.set(job.id, job);

    try {
      this.saveJobs();
    } catch (error) {
      this.jobs.delete(job.id);
      throw error;
    }

    return this.getJob(job.id);
  }

  getJob(jobId) {
    const job = this.jobs.get(jobId);

    return job ? structuredClone(job) : null;
  }

  listJobs() {
    return Array.from(this.jobs.keys()).map(
      (jobId) => this.getJob(jobId)
    );
  }

  transitionJob(jobId, nextStatus, details = {}) {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new Error("Migration job not found.");
    }

    const allowed = ALLOWED_TRANSITIONS[job.status] || [];

    if (!allowed.includes(nextStatus)) {
      throw new Error(
        `Invalid migration job transition: ${job.status} -> ${nextStatus}`
      );
    }

    const previousJob = structuredClone(job);

    job.status = nextStatus;
    job.updatedAt = new Date().toISOString();

    if (nextStatus === "failed") {
      job.error =
        typeof details.error === "string" &&
        details.error.trim()
          ? details.error
          : "Migration failed.";
    }

    if (nextStatus === "queued") {
      job.progress = 0;
      job.error = null;
    }

    if (nextStatus === "running") {
      job.error = null;
    }

    if (
      nextStatus === "queued" &&
      Number.isInteger(details.progress) &&
      details.progress === 0
    ) {
      job.progress = 0;
      job.error = null;
    }

    if (nextStatus === "completed") {
      job.progress = 100;
    }

    try {
      this.saveJobs();
    } catch (error) {
      this.jobs.set(jobId, previousJob);
      throw error;
    }

    return this.getJob(jobId);
  }

  updateProgress(jobId, progress) {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new Error("Migration job not found.");
    }

    if (job.status !== "running") {
      throw new Error(
        "Only running jobs can update progress."
      );
    }

    if (
      !Number.isInteger(progress) ||
      progress < job.progress ||
      progress < 0 ||
      progress > 100
    ) {
      throw new Error(
        "Progress must be an integer between the current progress and 100."
      );
    }

    const previousProgress = job.progress;
    const previousUpdatedAt = job.updatedAt;

    job.progress = progress;
    job.updatedAt = new Date().toISOString();

    try {
      this.saveJobs();
    } catch (error) {
      job.progress = previousProgress;
      job.updatedAt = previousUpdatedAt;
      throw error;
    }

    return this.getJob(jobId);
  }

  // Persist proposals, approval metadata, and execution results.
  updateJobDetails(jobId, details = {}) {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new Error("Migration job not found.");
    }

    if (
      !details ||
      typeof details !== "object" ||
      Array.isArray(details)
    ) {
      throw new Error("Job details must be an object.");
    }

    for (const key of Object.keys(details)) {
      if (!ALLOWED_JOB_FIELDS.has(key)) {
        throw new Error(
          `Invalid job detail field: ${key}`
        );
      }
    }

    if (
      Object.hasOwn(details, "proposals") &&
      !Array.isArray(details.proposals)
    ) {
      throw new Error("Proposals must be an array.");
    }

    if (
      Object.hasOwn(details, "changesApplied") &&
      typeof details.changesApplied !== "boolean"
    ) {
      throw new Error(
        "changesApplied must be a boolean."
      );
    }

    const previousJob = structuredClone(job);

    Object.assign(job, structuredClone(details));
    job.updatedAt = new Date().toISOString();

    try {
      this.saveJobs();
    } catch (error) {
      this.jobs.set(jobId, previousJob);
      throw error;
    }

    return this.getJob(jobId);
  }
}

module.exports = { MigrationEngine };