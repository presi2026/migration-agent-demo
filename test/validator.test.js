"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { validateProposal } = require("../src/validator");

test("accepts valid JavaScript even when the source path ends in .py", async () => {
  const result = await validateProposal({
    filePath: "examples/hello.py",
    targetLanguage: "JavaScript",
    proposal: [
      "function greet(name) {",
      "  return `Hello, ${name}!`;",
      "}",
      'console.log(greet("World"));',
    ].join("\n"),
  });

  assert.equal(result.success, true, result.errors.join("\n"));
});

test("rejects invalid JavaScript syntax", async () => {
  const result = await validateProposal({
    filePath: "examples/hello.py",
    targetLanguage: "JavaScript",
    proposal: "function greet( {",
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.length > 0);
});

test("accepts valid Python syntax", async () => {
  const result = await validateProposal({
    filePath: "examples/hello.py",
    targetLanguage: "Python",
    proposal: [
      "def greet(name):",
      '    return f"Hello, {name}!"',
    ].join("\n"),
  });

  assert.equal(result.success, true, result.errors.join("\n"));
});

test("rejects invalid Python syntax", async () => {
  const result = await validateProposal({
    filePath: "examples/hello.py",
    targetLanguage: "Python",
    proposal: "def greet(:\n    return 1",
  });

  assert.equal(result.success, false);
  assert.ok(result.errors.length > 0);
});
