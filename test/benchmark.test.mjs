import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  atomicWriteJson,
  buildSchedule,
  observationFromRun,
  runBenchmark,
  summarizeBenchmark,
  validateBenchmarkSuite,
} from "../src/benchmark.mjs";

const task = {
  id: "reject-expired-session-token",
  title: "Bounded task",
  issue: "A bounded behavior needs a fix.",
  repository: {
    url: "https://github.com/nnennandukwe/pi-qodo-quality-fixture.git",
    clone_ref: "main",
    base_ref: "origin/main",
    expected_base_sha: "2f37e9f3e1a5cb6d22e9f95e3c6c99e1772afa8f",
    repo_full_name: "nnennandukwe/pi-qodo-quality-fixture",
  },
  acceptance_criteria: ["The behavior is fixed"],
  files_expected: ["src/value.ts", "tests/value.test.ts"],
  files_allowed: ["src/value.ts", "tests/value.test.ts"],
  required_test_files: ["tests/value.test.ts"],
  constraints: ["No dependencies"],
  non_goals: ["No redesign"],
  verification: [
    {
      id: "held-out-oracle",
      argv: [
        "node",
        "--experimental-strip-types",
        "{harness_root}/oracles/session-expiry.mjs",
        ".",
      ],
      required: true,
    },
    { id: "tests", argv: ["npm", "test"], required: true },
    { id: "lint", argv: ["npm", "run", "lint"], required: true },
    { id: "format", argv: ["npm", "run", "format:check"], required: true },
    { id: "typecheck", argv: ["npm", "run", "typecheck"], required: true },
    { id: "security", argv: ["npm", "run", "security"], required: true },
  ],
};

const policyTasks = [
  ["reject-expired-session-token", "session-expiry.mjs"],
  ["validate-service-port-range", "service-port-range.mjs"],
  ["cover-tag-parser-edge-cases", "tag-parser-edges.mjs"],
  ["deduplicate-email-canonicalization", "email-normalization-refactor.mjs"],
  ["block-download-path-prefix-escape", "download-path-containment.mjs"],
];

function taskForPolicy(taskId, oracle) {
  return {
    ...task,
    id: taskId,
    verification: task.verification.map((check) =>
      check.id === "held-out-oracle"
        ? {
            ...check,
            argv: [
              "node",
              "--experimental-strip-types",
              `{harness_root}/oracles/${oracle}`,
              ".",
            ],
          }
        : check,
    ),
  };
}

async function writeCanonicalSuite(projectRoot, suiteId, { duplicateLastTask = false } = {}) {
  const oracleRoot = path.join(projectRoot, "oracles");
  await mkdir(oracleRoot, { recursive: true });
  for (const [, oracle] of policyTasks) {
    await writeFile(path.join(oracleRoot, oracle), "// benchmark test oracle\n");
  }
  const entries = [];
  for (const [index, [policyTaskId, policyOracle]] of policyTasks.entries()) {
    const [taskId, oracle] =
      duplicateLastTask && index === policyTasks.length - 1 ? policyTasks[0] : [policyTaskId, policyOracle];
    const manifest = `task-${index + 1}.json`;
    await writeFile(
      path.join(projectRoot, manifest),
      `${JSON.stringify(taskForPolicy(taskId, oracle))}\n`,
    );
    entries.push({
      category: `category-${index + 1}`,
      manifest,
      first_condition: index % 2 === 0 ? "baseline" : "factory",
    });
  }
  const suitePath = path.join(projectRoot, "suite.json");
  await writeFile(
    suitePath,
    `${JSON.stringify({
      schema_version: "mini-dark-factory-benchmark-suite/v1",
      id: suiteId,
      tasks: entries,
    })}\n`,
  );
  return suitePath;
}

function observation(condition, overrides = {}, taskValue = task) {
  return {
    condition,
    task_id: taskValue.id,
    base_sha: "2f37e9f3e1a5cb6d22e9f95e3c6c99e1772afa8f",
    terminal_status: "COMPLETE",
    success: true,
    implementation_gate_passed: true,
    required_checks_passed: true,
    failed_checks: [],
    verifier_catch: false,
    wall_time_ms: condition === "factory" ? 200 : 100,
    time_to_verification_ms: condition === "factory" ? 120 : 90,
    verification_commands_duration_ms: 10,
    review_time_ms: condition === "factory" ? 80 : null,
    usage: {
      input_tokens: condition === "factory" ? 2000 : 1000,
      output_tokens: condition === "factory" ? 200 : 100,
      cost_usd: condition === "factory" ? 0.2 : 0.1,
      turns: condition === "factory" ? 4 : 2,
    },
    changed_files: taskValue.files_expected,
    unnecessary_files: [],
    receipt_path: `.factory-runs/${condition}/artifacts/receipt.json`,
    qodo_review:
      condition === "factory"
        ? {
            decision: "approve",
            evidence_sufficient: true,
            findings: [],
            skipped_checks: [],
            duration_ms: 80,
          }
        : null,
    ...overrides,
  };
}

function conditionResult(condition, overrides = {}, taskValue = task) {
  const { condition: _schedulerOwned, ...result } = observation(condition, overrides, taskValue);
  return result;
}

test("benchmark suite builds a counterbalanced paired schedule", () => {
  const suite = {
    schema_version: "mini-dark-factory-benchmark-suite/v1",
    id: "suite",
    tasks: policyTasks.map((_, index) => ({
      category: `category-${index + 1}`,
      manifest: `tasks/${index + 1}.json`,
      first_condition: index % 2 === 0 ? "baseline" : "factory",
    })),
  };

  assert.equal(validateBenchmarkSuite(suite).ok, true);
  assert.deepEqual(
    buildSchedule(suite)
      .slice(0, 4)
      .map(({ category, condition }) => ({ category, condition })),
    [
      { category: "category-1", condition: "baseline" },
      { category: "category-1", condition: "factory" },
      { category: "category-2", condition: "factory" },
      { category: "category-2", condition: "baseline" },
    ],
  );
});

test("benchmark suite rejects an omitted task", () => {
  const suite = {
    schema_version: "mini-dark-factory-benchmark-suite/v1",
    id: "incomplete-suite",
    tasks: policyTasks.slice(0, 4).map((_, index) => ({
      category: `category-${index + 1}`,
      manifest: `tasks/${index + 1}.json`,
      first_condition: "baseline",
    })),
  };

  assert.match(validateBenchmarkSuite(suite).errors.join("\n"), /exactly 5 tasks/);
});

test("benchmark summary reports paired overhead and verifier catches", () => {
  const summary = summarizeBenchmark(
    { id: "suite" },
    [
      observation("baseline", {
        required_checks_passed: false,
        failed_checks: ["held-out-oracle"],
        verifier_catch: true,
        success: false,
        terminal_status: "FAILED",
      }),
      observation("factory"),
    ],
  );

  assert.equal(summary.conditions.baseline.completion_rate, 0);
  assert.equal(summary.conditions.baseline.verifier_catches, 1);
  assert.equal(summary.conditions.factory.completion_rate, 1);
  assert.equal(summary.paired.factory_minus_baseline.wall_time_ms, 100);
  assert.equal(summary.measurement_gaps.human_review_time_ms, null);
});

test("atomic JSON write preserves the prior checkpoint when commit fails", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-benchmark-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkpoint = path.join(directory, "result.json");
  await atomicWriteJson(checkpoint, { generation: 1 });

  await assert.rejects(
    atomicWriteJson(
      checkpoint,
      { generation: 2 },
      {
        renameImpl: async () => {
          throw new Error("injected rename failure");
        },
      },
    ),
    /injected rename failure/,
  );

  assert.deepEqual(JSON.parse(await readFile(checkpoint, "utf8")), { generation: 1 });
  assert.deepEqual((await readdir(directory)).sort(), ["result.json"]);
});

test("atomic JSON write preserves the prior checkpoint when staging fails", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-benchmark-write-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkpoint = path.join(directory, "result.json");
  await atomicWriteJson(checkpoint, { generation: 1 });

  await assert.rejects(
    atomicWriteJson(
      checkpoint,
      { generation: 2 },
      {
        writeFileImpl: async () => {
          throw new Error("injected write failure");
        },
      },
    ),
    /injected write failure/,
  );

  assert.deepEqual(JSON.parse(await readFile(checkpoint, "utf8")), { generation: 1 });
  assert.deepEqual((await readdir(directory)).sort(), ["result.json"]);
});

test("an interrupted benchmark resumes without rerunning a committed condition", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-resume-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "resume-suite");
  const config = {
    provider: "test-provider",
    model: "test-model",
    thinking: "medium",
    qodo_depth: "fast",
  };
  const firstCalls = [];

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config,
      benchmarkId: "resume-case",
      executeCondition: async ({ condition, task: taskValue }) => {
        firstCalls.push(condition);
        if (condition === "factory") throw new Error("injected external failure");
        return conditionResult(condition, {}, taskValue);
      },
    }),
    /Resume with --resume/,
  );
  assert.deepEqual(firstCalls, ["baseline", "factory"]);

  const resumedCalls = [];
  const benchmarkDir = path.join(projectRoot, ".factory-runs", "benchmarks", "resume-case");
  const result = await runBenchmark({
    projectRoot,
    suitePath,
    config,
    resumeDir: benchmarkDir,
    executeCondition: async ({ condition, task: taskValue }) => {
      resumedCalls.push(condition);
      return conditionResult(condition, {}, taskValue);
    },
  });

  assert.equal(resumedCalls[0], "factory");
  assert.equal(resumedCalls.length, 9);
  assert.equal(result.summary.runs.length, 10);
  assert.equal(result.summary.complete, true);
});

test("benchmark rejects a wrong but well-formed fixture base before checkpointing", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-base-drift-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "drift-suite");

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config: {
        provider: "test-provider",
        model: "test-model",
        thinking: "medium",
        qodo_depth: "fast",
      },
      benchmarkId: "base-drift",
      executeCondition: async ({ condition, task: taskValue }) =>
        conditionResult(condition, { base_sha: "b".repeat(40) }, taskValue),
    }),
    /base_sha must equal the policy-pinned SHA/,
  );

  assert.deepEqual(
    await readdir(path.join(projectRoot, ".factory-runs", "benchmarks", "base-drift", "results")),
    [],
  );
});

test("benchmark rejects a manifest command outside the allowlist before execution", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-command-policy-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "unsafe-suite");
  const unsafeTask = {
    ...task,
    verification: task.verification.map((check) =>
      check.id === "security" ? { ...check, argv: ["env"] } : check,
    ),
  };
  await writeFile(path.join(projectRoot, "task-1.json"), `${JSON.stringify(unsafeTask)}\n`);
  let executed = false;

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config: {},
      benchmarkId: "unsafe-command",
      executeCondition: async () => {
        executed = true;
        return conditionResult("baseline");
      },
    }),
    /security command is outside the benchmark allowlist/,
  );
  assert.equal(executed, false);
});

test("benchmark rejects repository metadata outside the fixture allowlist", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-repository-policy-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "repository-suite");
  const wrongRepository = {
    ...task,
    repository: { ...task.repository, url: "file:///tmp/untrusted-fixture" },
  };
  await writeFile(path.join(projectRoot, "task-1.json"), `${JSON.stringify(wrongRepository)}\n`);
  let executed = false;

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config: {},
      benchmarkId: "unsafe-repository",
      executeCondition: async () => {
        executed = true;
        return conditionResult("baseline");
      },
    }),
    /repository URL must be https:\/\/github.com\/nnennandukwe\/pi-qodo-quality-fixture.git/,
  );
  assert.equal(executed, false);
});

test("benchmark suite rejects a duplicate policy task ID", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-duplicate-task-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "duplicate-suite", {
    duplicateLastTask: true,
  });
  let executed = false;

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config: {},
      benchmarkId: "duplicate-task",
      executeCondition: async () => {
        executed = true;
        return conditionResult("baseline");
      },
    }),
    /exactly once to every policy task ID/,
  );
  assert.equal(executed, false);
});

test("resume rejects a corrupted observation before aggregation", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-corrupt-resume-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "corrupt-suite");
  const config = { provider: "test", model: "test", thinking: "medium", qodo_depth: "fast" };
  const initial = await runBenchmark({
    projectRoot,
    suitePath,
    config,
    benchmarkId: "corrupt-record",
    executeCondition: async ({ condition, task: taskValue }) =>
      conditionResult(condition, {}, taskValue),
  });
  const firstRecordPath = path.join(
    initial.benchmarkDir,
    "results",
    "01-reject-expired-session-token-baseline.json",
  );
  const corrupted = JSON.parse(await readFile(firstRecordPath, "utf8"));
  delete corrupted.unnecessary_files;
  await writeFile(firstRecordPath, `${JSON.stringify(corrupted)}\n`);
  let executed = false;

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config,
      resumeDir: initial.benchmarkDir,
      executeCondition: async () => {
        executed = true;
        return conditionResult("baseline");
      },
    }),
    /Resume rejected malformed or mismatched record.*unnecessary_files/,
  );
  assert.equal(executed, false);
});

test("benchmark rejects an unknown terminal status before checkpointing", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-status-policy-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "status-suite");

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config: {},
      benchmarkId: "unknown-status",
      executeCondition: async ({ condition, task: taskValue }) =>
        conditionResult(
          condition,
          { terminal_status: "COMPLETE-ish", success: false },
          taskValue,
        ),
    }),
    /terminal_status is not recognized/,
  );
});

test("condition callbacks cannot override scheduler-owned condition metadata", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-condition-owner-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "condition-suite");

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config: {},
      benchmarkId: "condition-owner",
      executeCondition: async ({ condition, task: taskValue }) => ({
        ...conditionResult(condition, {}, taskValue),
        condition: "factory",
      }),
    }),
    /scheduler-owned fields: condition/,
  );
});

test("benchmark rejects a symlinked checkpoint directory", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-symlink-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-symlink-target-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "symlink-suite");
  const benchmarkRoot = path.join(projectRoot, ".factory-runs", "benchmarks");
  await mkdir(benchmarkRoot, { recursive: true });
  const linked = path.join(benchmarkRoot, "linked-run");
  await symlink(outside, linked, "dir");
  let executed = false;

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config: {},
      resumeDir: linked,
      executeCondition: async () => {
        executed = true;
        return conditionResult("baseline");
      },
    }),
    /checkpoint directory must be a real directory, not a symlink/,
  );
  assert.equal(executed, false);
});

test("resume rejects symlinked benchmark metadata", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-metadata-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-metadata-target-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "metadata-symlink-suite");
  const config = { provider: "test", model: "test", thinking: "medium", qodo_depth: "fast" };
  const initial = await runBenchmark({
    projectRoot,
    suitePath,
    config,
    benchmarkId: "metadata-symlink",
    executeCondition: async ({ condition, task: taskValue }) =>
      conditionResult(condition, {}, taskValue),
  });
  const metadataPath = path.join(initial.benchmarkDir, "metadata.json");
  const outsideMetadata = path.join(outside, "metadata.json");
  await writeFile(outsideMetadata, await readFile(metadataPath));
  await rm(metadataPath);
  await symlink(outsideMetadata, metadataPath);

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config,
      resumeDir: initial.benchmarkDir,
      executeCondition: async ({ condition, task: taskValue }) =>
        conditionResult(condition, {}, taskValue),
    }),
    /benchmark metadata must be a regular file, not a symlink/,
  );
});

test("resume rejects a symlinked condition record", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-record-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-record-target-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "record-symlink-suite");
  const config = { provider: "test", model: "test", thinking: "medium", qodo_depth: "fast" };
  const initial = await runBenchmark({
    projectRoot,
    suitePath,
    config,
    benchmarkId: "record-symlink",
    executeCondition: async ({ condition, task: taskValue }) =>
      conditionResult(condition, {}, taskValue),
  });
  const recordPath = path.join(
    initial.benchmarkDir,
    "results",
    "01-reject-expired-session-token-baseline.json",
  );
  const outsideRecord = path.join(outside, "record.json");
  await writeFile(outsideRecord, await readFile(recordPath));
  await rm(recordPath);
  await symlink(outsideRecord, recordPath);

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config,
      resumeDir: initial.benchmarkDir,
      executeCondition: async ({ condition, task: taskValue }) =>
        conditionResult(condition, {}, taskValue),
    }),
    /benchmark condition record must be a regular file, not a symlink/,
  );
});

test("benchmark rejects a symlinked held-out oracle", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-oracle-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-oracle-target-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "oracle-symlink-suite");
  const oraclePath = path.join(projectRoot, "oracles", "session-expiry.mjs");
  const outsideOracle = path.join(outside, "session-expiry.mjs");
  await writeFile(outsideOracle, "// outside oracle\n");
  await rm(oraclePath);
  await symlink(outsideOracle, oraclePath);
  let executed = false;

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config: {},
      benchmarkId: "oracle-symlink",
      executeCondition: async () => {
        executed = true;
        return conditionResult("baseline");
      },
    }),
    /held-out oracle must be a regular file, not a symlink/,
  );
  assert.equal(executed, false);
});

test("a fresh benchmark rejects a pre-existing directory without metadata", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-stale-directory-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "stale-directory-suite");
  const benchmarkDir = path.join(projectRoot, ".factory-runs", "benchmarks", "stale-directory");
  await mkdir(path.join(benchmarkDir, "results"), { recursive: true });
  await writeFile(path.join(benchmarkDir, "results", "stale.json"), "{}\n");
  let executed = false;

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config: {},
      benchmarkId: "stale-directory",
      executeCondition: async () => {
        executed = true;
        return conditionResult("baseline");
      },
    }),
    /Benchmark already exists.*use --resume/,
  );
  assert.equal(executed, false);
});

test("benchmark rejects a symlinked suite manifest", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-suite-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-suite-target-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "suite-symlink");
  const outsideSuite = path.join(outside, "suite.json");
  await writeFile(outsideSuite, await readFile(suitePath));
  await rm(suitePath);
  await symlink(outsideSuite, suitePath);

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config: {},
      benchmarkId: "suite-symlink",
      executeCondition: async ({ condition, task: taskValue }) =>
        conditionResult(condition, {}, taskValue),
    }),
    /benchmark suite must be a regular file, not a symlink/,
  );
});

test("benchmark rejects a symlinked task manifest", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-task-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-task-target-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const suitePath = await writeCanonicalSuite(projectRoot, "task-symlink");
  const taskPath = path.join(projectRoot, "task-1.json");
  const outsideTask = path.join(outside, "task-1.json");
  await writeFile(outsideTask, await readFile(taskPath));
  await rm(taskPath);
  await symlink(outsideTask, taskPath);

  await assert.rejects(
    runBenchmark({
      projectRoot,
      suitePath,
      config: {},
      benchmarkId: "task-symlink",
      executeCondition: async ({ condition, task: taskValue }) =>
        conditionResult(condition, {}, taskValue),
    }),
    /benchmark task manifest must be a regular file, not a symlink/,
  );
});

test("run observation rejects a receipt artifact path outside its run directory", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-artifact-path-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runDir = path.join(projectRoot, "run");
  const artifactsDir = path.join(runDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  await assert.rejects(
    observationFromRun({
      projectRoot,
      task,
      condition: "baseline",
      runResult: {
        runDir,
        artifactsDir,
        receipt: {
          artifact_paths: { verification: "../outside.json" },
        },
      },
    }),
    /verification artifact path escapes the run directory/,
  );
});

test("run observation rejects symlinked artifact path components", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-artifact-symlink-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-artifact-target-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const runDir = path.join(projectRoot, "run");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(outside, "verification.json"),
    `${JSON.stringify({ changed_files: [], checks: [] })}\n`,
  );
  await symlink(outside, path.join(runDir, "artifacts"), "dir");

  await assert.rejects(
    observationFromRun({
      projectRoot,
      task,
      condition: "baseline",
      runResult: {
        runDir,
        artifactsDir: path.join(runDir, "artifacts"),
        receipt: {
          artifact_paths: { verification: "artifacts/verification.json" },
        },
      },
    }),
    /verification artifact path must not contain symlinks/,
  );
});

test("run observation rejects disagreement between the verification gate and artifact", async (t) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-verification-mismatch-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const runDir = path.join(projectRoot, "run");
  const artifactsDir = path.join(runDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(
    path.join(artifactsDir, "verification.json"),
    `${JSON.stringify({
      changed_files: task.files_expected,
      checks: [{ id: "held-out-oracle", required: true, exit_code: 1 }],
    })}\n`,
  );

  await assert.rejects(
    observationFromRun({
      projectRoot,
      task,
      condition: "baseline",
      runResult: {
        runDir,
        artifactsDir,
        receipt: {
          gates: { implementation: { ok: true }, verification: { passed: true } },
          artifact_paths: { verification: "artifacts/verification.json" },
        },
      },
    }),
    /Verification gate and artifact disagree/,
  );
});
