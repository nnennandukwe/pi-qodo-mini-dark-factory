import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateImplementationReport, validatePlan, validateTask } from "../src/contracts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const task = JSON.parse(
  await readFile(path.join(root, "tasks", "reject-expired-session-token.json"), "utf8"),
);

test("planner gate requires non-goals", () => {
  const result = validatePlan(
    {
      task_id: task.id,
      summary: "Plan",
      acceptance_criteria: task.acceptance_criteria,
      affected_files: task.files_expected,
      steps: ["Change code"],
      risks: ["Boundary"],
      non_goals: [],
    },
    task,
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /non_goals/);
});

test("implementation gate rejects an out-of-scope file", () => {
  const actual = [...task.files_expected, "unexpected.txt"];
  const result = validateImplementationReport(
    {
      task_id: task.id,
      summary: "Implementation",
      changed_files: actual,
      commands_run: [],
      assumptions: [],
      unresolved_risks: [],
    },
    task,
    actual,
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /out-of-scope/);
});

test("task gate accepts exactly one repository source", () => {
  const repositoryTask = {
    ...task,
    fixture: undefined,
    repository: {
      url: "https://example.com/repo.git",
      clone_ref: "main",
      base_ref: "origin/main",
      repo_full_name: "example/repo",
    },
  };
  assert.equal(validateTask(repositoryTask).ok, true);
  assert.match(
    validateTask({ ...repositoryTask, fixture: "fixtures/token-service" }).errors.join("\n"),
    /exactly one source/,
  );
});

test("all five benchmark task manifests satisfy the task contract", async () => {
  const suite = JSON.parse(await readFile(path.join(root, "tasks", "benchmark-suite.json"), "utf8"));
  assert.equal(suite.tasks.length, 5);
  for (const entry of suite.tasks) {
    const manifest = JSON.parse(await readFile(path.join(root, entry.manifest), "utf8"));
    assert.deepEqual(validateTask(manifest), { ok: true, errors: [] }, entry.manifest);
  }
});
