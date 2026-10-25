"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_FILE_BYTES = 200_000;
const TIMEOUT_MS = 30_000;

const VALIDATORS = {
  javascript: {
    image: "node:24-alpine",
    args: (file) => ["node", "--check", `/workspace/${file}`],
  },
  python: {
    image: "python:3.13-alpine",
    args: (file) => [
      "python",
      "-c",
      "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read(), filename=sys.argv[1])",
      `/workspace/${file}`,
    ],
  },
};

function normalizeLanguage(language) {
  const value = String(language || "").trim().toLowerCase();

  if (["js", "javascript", "node", "node.js"].includes(value)) {
    return "javascript";
  }

  if (["py", "python"].includes(value)) {
    return "python";
  }

  return value;
}

function runDocker(args) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");

      finish({
        success: false,
        errors: ["Docker validation timed out."],
        checks: ["docker-syntax"],
      });
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-10000);
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-10000);
    });

    child.on("error", (error) => {
      finish({
        success: false,
        errors: [`Unable to start Docker: ${error.message}`],
        checks: ["docker-syntax"],
      });
    });

    child.on("close", (code) => {
      finish({
        success: code === 0,
        errors:
          code === 0
            ? []
            : [
                (
                  stderr ||
                  stdout ||
                  `Docker exited with code ${code}`
                ).trim(),
              ],
        checks: ["docker-syntax"],
      });
    });
  });
}

async function validateProposal({
  filePath,
  proposal,
  targetLanguage,
}) {
  const language = normalizeLanguage(targetLanguage);
  const validator = VALIDATORS[language];

  if (!validator) {
    return {
      success: false,
      errors: [
        `No syntax validator is configured for ${targetLanguage}.`,
      ],
      checks: [],
    };
  }

  if (
    typeof filePath !== "string" ||
    !filePath.trim() ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.includes("\0") ||
    filePath.split("/").some(
      (part) => !part || part === "." || part === ".."
    ) ||
    /^[a-zA-Z]:/.test(filePath)
  ) {
    return {
      success: false,
      errors: ["Invalid file path."],
      checks: [],
    };
  }

  if (typeof proposal !== "string") {
    return {
      success: false,
      errors: ["Proposal must be a string."],
      checks: [],
    };
  }

  if (Buffer.byteLength(proposal, "utf8") > MAX_FILE_BYTES) {
    return {
      success: false,
      errors: ["Proposal exceeds the file size limit."],
      checks: [],
    };
  }

  let directory;

  try {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "migration-validation-")
    );
    fs.chmodSync(directory, 0o755);

    // Validate generated code using its target-language extension,
    // not the original source file's extension.
    const parsedPath = path.parse(filePath);
    const validationPath =
      language === "javascript" &&
      ![".js", ".cjs", ".mjs"].includes(parsedPath.ext.toLowerCase())
        ? path.join(parsedPath.dir, `${parsedPath.name}.js`)
        : filePath;

    const safePath = path.resolve(directory, validationPath);
    const relativePath = path.relative(directory, safePath);

    if (
      path.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`)
    ) {
      return {
        success: false,
        errors: ["Invalid workspace path."],
        checks: [],
      };
    }

    fs.mkdirSync(path.dirname(safePath), {
      recursive: true,
      mode: 0o755,
    });
    fs.chmodSync(path.dirname(safePath), 0o755);

    fs.writeFileSync(safePath, proposal, {
      encoding: "utf8",
      mode: 0o644,
      flag: "wx",
    });

    // Docker runs with a read-only workspace mount.
    // The proposed file must exist before the container starts.
    if (!fs.statSync(safePath).isFile()) {
      throw new Error("The proposal file was not created.");
    }

    const containerPath = relativePath
      .split(path.sep)
      .join("/");

    return await runDocker([
      "run",
      "--rm",
      "--network=none",
      "--memory=256m",
      "--cpus=1",
      "--pids-limit=64",
      "--read-only",
      "--security-opt=no-new-privileges",
      "--cap-drop=ALL",
      "--user=65534:65534",
      "--mount",
      `type=bind,source=${directory},target=/workspace,readonly`,
      "--workdir=/workspace",
      validator.image,
      ...validator.args(containerPath),
    ]);
  } catch (error) {
    return {
      success: false,
      errors: [
        error instanceof Error
          ? error.message
          : "Validation failed.",
      ],
      checks: ["docker-syntax"],
    };
  } finally {
    if (directory) {
      fs.rmSync(directory, {
        recursive: true,
        force: true,
      });
    }
  }
}

module.exports = {
  validateProposal,
  normalizeLanguage,
};
