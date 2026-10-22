"use strict";

const express = require("express");
const path = require("node:path");
const OpenAI = require("openai");

const { createMigrationPlan } = require("./agent");
const { MigrationEngine } = require("./migration-engine");

const app = express();
const port = Number(process.env.PORT) || 3000;
const migrationEngine = new MigrationEngine();

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const aiConfigured = Boolean(process.env.OPENROUTER_API_KEY);

const ai = aiConfigured
  ? new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    })
  : null;

function validRepository(repository) {
  return (
    typeof repository === "string" &&
    /^[^/\s]+\/[^/\s]+$/.test(repository)
  );
}

function validBranch(branch) {
  return (
    typeof branch === "string" &&
    branch.length > 0 &&
    !branch.startsWith("-")
  );
}

function validFilePath(filePath) {
  return (
    typeof filePath === "string" &&
    filePath.trim().length > 0 &&
    !filePath.startsWith("/") &&
    !filePath.includes("\\") &&
    !filePath.split("/").some(
      (part) => part === "." || part === ".."
    )
  );
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "migration-agent-demo",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

function githubContentsUrl(repository, filePath, branch) {
  const encodedPath = filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const url = new URL(
    `https://api.github.com/repos/${repository}/contents/${encodedPath}`
  );

  if (branch) {
    url.searchParams.set("ref", branch);
  }

  return url;
}

async function githubRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...githubHeaders(),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message ||
        `GitHub API request failed (${response.status}).`
    );
  }

  return data;
}

function decodeGitHubContent(content) {
  return Buffer.from(
    content.replace(/\s/g, ""),
    "base64"
  ).toString("utf8");
}

async function generateProposal({
  sourceLanguage,
  targetLanguage,
  filePath,
  sourceCode,
}) {
  if (!ai) {
    throw new Error(
      "AI is not configured. Check the OPENROUTER_API_KEY Codespace secret."
    );
  }

  const completion = await ai.chat.completions.create({
    model: process.env.OPENROUTER_MODEL || "openrouter/free",
    messages: [
      {
        role: "system",
        content:
          "You are a software migration assistant. Return only the proposed migrated source code. Preserve behavior, avoid unrelated changes, and never claim that files have been changed.",
      },
      {
        role: "user",
        content:
          `Migrate this file from ${sourceLanguage} to ${targetLanguage}.\n` +
          `File: ${filePath}\n\n` +
          "Return only the migrated code, without Markdown fences.\n\n" +
          "Source code:\n" +
          sourceCode,
      },
    ],
  });

  const proposal = completion.choices?.[0]?.message?.content;

  if (typeof proposal !== "string" || !proposal.trim()) {
    throw new Error("The AI provider returned an empty proposal.");
  }

  return proposal.trim();
}

function requireMigrationInputs(body) {
  return (
    body &&
    typeof body.sourceLanguage === "string" &&
    body.sourceLanguage.trim() &&
    typeof body.targetLanguage === "string" &&
    body.targetLanguage.trim()
  );
}

function errorMessage(error, fallback) {
  return error instanceof Error ? error.message : fallback;
}

// Diagnostic endpoint
app.get("/api/debug/routes", (req, res) => {
  const routerStack = app.router?.stack || [];

  const routes = routerStack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods || {}),
    }));

  return res.json({
    success: true,
    routes,
    batchRouteRegistered: routes.some(
      (route) =>
        route.path === "/api/migrate/batch" &&
        route.methods.includes("post")
    ),
  });
});

// Create a migration plan
app.post("/api/plan", (req, res) => {
  try {
    const plan = createMigrationPlan(req.body);

    return res.json({ success: true, plan });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: errorMessage(
        error,
        "Unable to create migration plan."
      ),
    });
  }
});

// Read a file from a public GitHub repository
app.get("/api/github-file", async (req, res) => {
  try {
    const { repository, filePath } = req.query;
    const branch = req.query.branch || "main";

    if (!validRepository(repository)) {
      return res.status(400).json({
        success: false,
        error: "Repository must use owner/repository format.",
      });
    }

    if (
      !validFilePath(filePath) ||
      !validBranch(branch)
    ) {
      return res.status(400).json({
        success: false,
        error: "A valid file path and branch are required.",
      });
    }

    const data = await githubRequest(
      githubContentsUrl(repository, filePath, branch)
    );

    if (data.type !== "file" || typeof data.content !== "string") {
      return res.status(400).json({
        success: false,
        error: "The requested path is not a readable file.",
      });
    }

    return res.json({
      success: true,
      repository,
      filePath: data.path,
      branch,
      sha: data.sha,
      content: decodeGitHubContent(data.content),
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      error: errorMessage(
        error,
        "Unable to read the GitHub file."
      ),
    });
  }
});

// List files in a GitHub repository
app.get("/api/github-files", async (req, res) => {
  try {
    const { repository } = req.query;
    const branch = req.query.branch || "main";

    if (
      !validRepository(repository) ||
      !validBranch(branch)
    ) {
      return res.status(400).json({
        success: false,
        error: "A valid repository and branch are required.",
      });
    }

    const url = new URL(
      `https://api.github.com/repos/${repository}/git/trees/${encodeURIComponent(branch)}`
    );

    url.searchParams.set("recursive", "1");

    const data = await githubRequest(url);

    const files = (data.tree || [])
      .filter((item) => item.type === "blob")
      .map((item) => ({
        path: item.path,
        sha: item.sha,
        size: item.size,
      }));

    return res.json({
      success: true,
      repository,
      branch,
      truncated: Boolean(data.truncated),
      count: files.length,
      files,
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      error: errorMessage(
        error,
        "Unable to list repository files."
      ),
    });
  }
});

// Generate a proposal for one file.
// This endpoint does not modify the repository.
app.post("/api/migrate", async (req, res) => {
  try {
    const {
      sourceLanguage,
      targetLanguage,
      filePath,
      sourceCode,
    } = req.body || {};

    if (
      !requireMigrationInputs(req.body) ||
      !validFilePath(filePath) ||
      typeof sourceCode !== "string"
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Source language, target language, valid file path, and source code are required.",
      });
    }

    const proposal = await generateProposal({
      sourceLanguage,
      targetLanguage,
      filePath,
      sourceCode,
    });

    return res.json({
      success: true,
      filePath,
      sourceLanguage,
      targetLanguage,
      proposal,
      status: "awaiting_review",
      changesApplied: false,
    });
  } catch (error) {
    return res.status(502).json({
      success: false,
      error: errorMessage(
        error,
        "Unable to generate migration proposal."
      ),
    });
  }
});

// Generate proposals for multiple files.
// This endpoint does not modify the repository.
app.post("/api/migrate/batch", async (req, res) => {
  try {
    const {
      sourceLanguage,
      targetLanguage,
      files,
    } = req.body || {};

    if (!requireMigrationInputs(req.body)) {
      return res.status(400).json({
        success: false,
        error: "Source and target languages are required.",
      });
    }

    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      files.length > 10
    ) {
      return res.status(400).json({
        success: false,
        error: "Provide between 1 and 10 files to migrate.",
      });
    }

    for (const file of files) {
      if (
        !file ||
        !validFilePath(file.filePath) ||
        typeof file.sourceCode !== "string"
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Each file must include a valid filePath and sourceCode string.",
        });
      }
    }

    const results = await Promise.all(
      files.map(async (file) => {
        try {
          const proposal = await generateProposal({
            sourceLanguage,
            targetLanguage,
            filePath: file.filePath,
            sourceCode: file.sourceCode,
          });

          return {
            success: true,
            filePath: file.filePath,
            status: "awaiting_review",
            changesApplied: false,
            proposal,
          };
        } catch (error) {
          return {
            success: false,
            filePath: file.filePath,
            status: "failed",
            changesApplied: false,
            error: errorMessage(
              error,
              "Unable to generate proposal."
            ),
          };
        }
      })
    );

    return res.json({
      success: results.every((result) => result.success),
      sourceLanguage,
      targetLanguage,
      count: results.length,
      results,
      changesApplied: false,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: errorMessage(error, "Batch migration failed."),
    });
  }
});

/* Migration job API */

// Create a job
app.post("/api/jobs", (req, res) => {
  try {
    const {
      repository,
      sourceLanguage,
      targetLanguage,
      files = [],
    } = req.body || {};

    if (!Array.isArray(files) || files.length > 100) {
      return res.status(400).json({
        success: false,
        error: "Files must be an array containing at most 100 entries.",
      });
    }

    const job = migrationEngine.createJob({
      repository,
      sourceLanguage,
      targetLanguage,
      files,
    });

    return res.status(201).json({
      success: true,
      job,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: errorMessage(error, "Unable to create migration job."),
    });
  }
});

// List jobs
app.get("/api/jobs", (req, res) => {
  const jobs = migrationEngine.listJobs();

  return res.json({
    success: true,
    count: jobs.length,
    jobs,
  });
});

// Get a job by ID
app.get("/api/jobs/:id", (req, res) => {
  const job = migrationEngine.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Migration job not found.",
    });
  }

  return res.json({ success: true, job });
});

// Change status to running.
// This endpoint does not execute migration code.
app.post("/api/jobs/:id/start", (req, res) => {
  try {
    const job = migrationEngine.transitionJob(
      req.params.id,
      "running"
    );

    return res.json({
      success: true,
      job,
      executionStarted: false,
      message:
        "Job status updated only. Migration execution is not implemented.",
    });
  } catch (error) {
    const message = errorMessage(error, "Unable to start job.");
    const status =
      message === "Migration job not found." ? 404 : 409;

    return res.status(status).json({
      success: false,
      error: message,
    });
  }
});

// Cancel an eligible job
app.post("/api/jobs/:id/cancel", (req, res) => {
  try {
    const job = migrationEngine.transitionJob(
      req.params.id,
      "cancelled"
    );

    return res.json({ success: true, job });
  } catch (error) {
    const message = errorMessage(error, "Unable to cancel job.");
    const status =
      message === "Migration job not found." ? 404 : 409;

    return res.status(status).json({
      success: false,
      error: message,
    });
  }
});

// JSON response for invalid API routes
app.use("/api", (req, res) => {
  return res.status(404).json({
    success: false,
    error: "API endpoint not found.",
  });
});

// Handle malformed JSON
app.use((error, req, res, next) => {
  if (
    error instanceof SyntaxError &&
    error.status === 400 &&
    "body" in error
  ) {
    return res.status(400).json({
      success: false,
      error: "Request body contains invalid JSON.",
    });
  }

  return next(error);
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Migration agent running on port ${port}`);
});