import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateTask } from "./contracts.mjs";

const SUITE_SCHEMA = "mini-dark-factory-benchmark-suite/v1";
const METADATA_SCHEMA = "mini-dark-factory-benchmark-metadata/v1";
const RECORD_SCHEMA = "mini-dark-factory-benchmark-condition/v1";
const SUMMARY_SCHEMA = "mini-dark-factory-benchmark-summary/v1";
const CONDITIONS = new Set(["baseline", "factory"]);
const BENCHMARK_REPOSITORY = "nnennandukwe/pi-qodo-quality-fixture";
const BENCHMARK_REPOSITORY_URL =
  "https://github.com/nnennandukwe/pi-qodo-quality-fixture.git";
const BENCHMARK_BASE_SHA = "2f37e9f3e1a5cb6d22e9f95e3c6c99e1772afa8f";
const BENCHMARK_CLONE_REF = "main";
const BENCHMARK_BASE_REF = "origin/main";
const TERMINAL_STATUSES = new Set([
  "COMPLETE",
  "FAILED",
  "AGENT_FAILED",
  "PLAN_REJECTED",
  "PLANNER_FAILED",
  "IMPLEMENTATION_REJECTED",
  "IMPLEMENTER_FAILED",
  "VERIFICATION_FAILED",
  "EVIDENCE_STALE",
  "CHANGES_REQUESTED",
  "REVIEW_REJECTED",
  "REVIEWER_FAILED",
]);
const TASK_ORACLES = new Map([
  ["reject-expired-session-token", "session-expiry.mjs"],
  ["validate-service-port-range", "service-port-range.mjs"],
  ["cover-tag-parser-edge-cases", "tag-parser-edges.mjs"],
  ["deduplicate-email-canonicalization", "email-normalization-refactor.mjs"],
  ["block-download-path-prefix-escape", "download-path-containment.mjs"],
]);
const STANDARD_VERIFICATION = new Map([
  ["tests", ["npm", "test"]],
  ["lint", ["npm", "run", "lint"]],
  ["format", ["npm", "run", "format:check"]],
  ["typecheck", ["npm", "run", "typecheck"]],
  ["security", ["npm", "run", "security"]],
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function round(value, places = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

function mean(values) {
  const numbers = values.filter(Number.isFinite);
  if (numbers.length === 0) return null;
  return round(numbers.reduce((total, value) => total + value, 0) / numbers.length);
}

function sum(values) {
  return round(values.filter(Number.isFinite).reduce((total, value) => total + value, 0));
}

function rate(numerator, denominator) {
  return denominator === 0 ? null : round(numerator / denominator);
}

function result(errors) {
  return { ok: errors.length === 0, errors };
}

function safeId(value, label) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new Error(`${label} must contain only lowercase letters, digits, and hyphens`);
  }
  return value;
}

function resolveProjectFile(projectRoot, relativePath) {
  if (!nonEmptyString(relativePath) || path.isAbsolute(relativePath)) {
    throw new Error(`Benchmark manifest must be a relative path: ${relativePath}`);
  }
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Benchmark manifest escapes the project root: ${relativePath}`);
  }
  return resolved;
}

async function readJson(file, label = "JSON file") {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink: ${file}`);
  }
  return JSON.parse(await readFile(file, "utf8"));
}

async function readJsonIfPresent(file, label = "JSON file") {
  try {
    return await readJson(file, label);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertRegularFileWithinRoot(file, root, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} path escapes its trusted root: ${file}`);
  }

  const rootStat = await lstat(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${label} root must be a real directory, not a symlink: ${resolvedRoot}`);
  }

  const components = path.relative(resolvedRoot, resolvedFile).split(path.sep);
  let current = resolvedRoot;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const stat = await lstat(current);
    const final = index === components.length - 1;
    if (stat.isSymbolicLink()) {
      if (final) throw new Error(`${label} must be a regular file, not a symlink: ${current}`);
      throw new Error(`${label} path must not contain symlinks: ${current}`);
    }
    if (final && !stat.isFile()) {
      throw new Error(`${label} must be a regular file: ${current}`);
    }
    if (!final && !stat.isDirectory()) {
      throw new Error(`${label} path component must be a directory: ${current}`);
    }
  }

  const [realRoot, realFile] = await Promise.all([realpath(resolvedRoot), realpath(resolvedFile)]);
  if (!realFile.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`${label} path escapes its trusted root: ${file}`);
  }
  return resolvedFile;
}

async function resolveRunArtifact(runDir, relativePath, label) {
  if (!nonEmptyString(relativePath) || path.isAbsolute(relativePath)) {
    throw new Error(`${label} artifact path must be relative to the run directory`);
  }
  const root = path.resolve(runDir);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} artifact path escapes the run directory: ${relativePath}`);
  }
  return assertRegularFileWithinRoot(resolved, root, `${label} artifact`);
}

async function readRunJsonIfPresent(runDir, relativePath, label) {
  try {
    const file = await resolveRunArtifact(runDir, relativePath, label);
    return await readJson(file, `${label} artifact`);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function assertCheckpointDirectory(directory, benchmarkRoot) {
  const factoryRuns = path.dirname(benchmarkRoot);
  for (const [label, candidate] of [
    ["factory run root", factoryRuns],
    ["benchmark root", benchmarkRoot],
    ["checkpoint directory", directory],
  ]) {
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} must be a real directory, not a symlink: ${candidate}`);
    }
  }
  const [resolvedRoot, resolvedDirectory] = await Promise.all([
    realpath(benchmarkRoot),
    realpath(directory),
  ]);
  if (
    resolvedDirectory !== resolvedRoot &&
    !resolvedDirectory.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error(`checkpoint directory escapes the benchmark root: ${directory}`);
  }
}

async function ensureRealDirectory(directory, label) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink: ${directory}`);
  }
}

export function validateBenchmarkSuite(suite) {
  const errors = [];
  if (!isPlainObject(suite)) return result(["benchmark suite must be an object"]);
  if (suite.schema_version !== SUITE_SCHEMA) {
    errors.push(`benchmark suite schema_version must be ${SUITE_SCHEMA}`);
  }
  if (!nonEmptyString(suite.id)) errors.push("benchmark suite id is required");
  else if (!/^[a-z0-9][a-z0-9-]*$/.test(suite.id)) {
    errors.push("benchmark suite id must contain only lowercase letters, digits, and hyphens");
  }
  if (!Array.isArray(suite.tasks) || suite.tasks.length !== TASK_ORACLES.size) {
    errors.push(`benchmark suite must contain exactly ${TASK_ORACLES.size} tasks`);
    return result(errors);
  }

  const categories = [];
  const manifests = [];
  for (const [index, entry] of suite.tasks.entries()) {
    if (!isPlainObject(entry)) {
      errors.push(`benchmark suite task ${index} must be an object`);
      continue;
    }
    if (!nonEmptyString(entry.category)) errors.push(`benchmark suite task ${index} category is required`);
    else categories.push(entry.category);
    if (!nonEmptyString(entry.manifest)) errors.push(`benchmark suite task ${index} manifest is required`);
    else manifests.push(entry.manifest);
    if (!CONDITIONS.has(entry.first_condition)) {
      errors.push(`benchmark suite task ${index} first_condition must be baseline or factory`);
    }
  }
  if (new Set(categories).size !== categories.length) {
    errors.push("benchmark suite categories must be unique");
  }
  if (new Set(manifests).size !== manifests.length) {
    errors.push("benchmark suite manifests must be unique");
  }
  return result(errors);
}

export function buildSchedule(suite) {
  return suite.tasks.flatMap((entry) => {
    const second = entry.first_condition === "baseline" ? "factory" : "baseline";
    return [
      { ...entry, condition: entry.first_condition },
      { ...entry, condition: second },
    ];
  });
}

export async function atomicWriteJson(
  file,
  value,
  {
    mkdirImpl = mkdir,
    writeFileImpl = writeFile,
    renameImpl = rename,
    rmImpl = rm,
  } = {},
) {
  await mkdirImpl(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFileImpl(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await renameImpl(temporary, file);
  } catch (error) {
    try {
      await rmImpl(temporary, { force: true });
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; temporary checkpoint cleanup failed at ${temporary}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }
}

function conditionSummary(records, condition) {
  const selected = records.filter((record) => record.condition === condition);
  const completed = selected.filter((record) => record.success).length;
  const checksPassed = selected.filter((record) => record.required_checks_passed).length;
  const passingVerificationTimes = selected
    .filter((record) => record.required_checks_passed)
    .map((record) => record.time_to_verification_ms);
  return {
    runs: selected.length,
    completed,
    completion_rate: rate(completed, selected.length),
    all_checks_passed: checksPassed,
    all_checks_pass_rate: rate(checksPassed, selected.length),
    verifier_catches: selected.filter((record) => record.verifier_catch).length,
    unnecessary_files_changed: selected.reduce(
      (total, record) => total + record.unnecessary_files.length,
      0,
    ),
    mean_wall_time_ms: mean(selected.map((record) => record.wall_time_ms)),
    mean_time_to_first_passing_implementation_ms: mean(passingVerificationTimes),
    usage: {
      input_tokens: sum(selected.map((record) => record.usage.input_tokens)),
      output_tokens: sum(selected.map((record) => record.usage.output_tokens)),
      cost_usd: sum(selected.map((record) => record.usage.cost_usd)),
      turns: sum(selected.map((record) => record.usage.turns)),
    },
  };
}

function pairedDelta(records, valueFor) {
  const tasks = new Map();
  for (const record of records) {
    const pair = tasks.get(record.task_id) ?? {};
    pair[record.condition] = record;
    tasks.set(record.task_id, pair);
  }
  const deltas = [];
  for (const pair of tasks.values()) {
    const baseline = pair.baseline ? valueFor(pair.baseline) : null;
    const factory = pair.factory ? valueFor(pair.factory) : null;
    if (Number.isFinite(baseline) && Number.isFinite(factory)) deltas.push(factory - baseline);
  }
  return mean(deltas);
}

export function summarizeBenchmark(metadata, records) {
  const expectedRuns = metadata.expected_runs ?? records.length;
  const qodoReviews = records.map((record) => record.qodo_review).filter(Boolean);
  return {
    schema_version: SUMMARY_SCHEMA,
    benchmark_id: metadata.benchmark_id ?? null,
    suite_id: metadata.suite_id ?? metadata.id,
    generated_at: new Date().toISOString(),
    complete: records.length === expectedRuns,
    expected_runs: expectedRuns,
    completed_run_records: records.length,
    conditions: {
      baseline: conditionSummary(records, "baseline"),
      factory: conditionSummary(records, "factory"),
    },
    paired: {
      factory_minus_baseline: {
        wall_time_ms: pairedDelta(records, (record) => record.wall_time_ms),
        time_to_verification_ms: pairedDelta(records, (record) => record.time_to_verification_ms),
        verification_commands_duration_ms: pairedDelta(
          records,
          (record) => record.verification_commands_duration_ms,
        ),
        cost_usd: pairedDelta(records, (record) => record.usage.cost_usd),
        input_tokens: pairedDelta(records, (record) => record.usage.input_tokens),
        output_tokens: pairedDelta(records, (record) => record.usage.output_tokens),
      },
    },
    qodo: {
      reviews_completed: qodoReviews.length,
      findings: qodoReviews.reduce((total, review) => total + review.findings.length, 0),
      action_required_findings: qodoReviews.reduce(
        (total, review) =>
          total + review.findings.filter((finding) => ["high", "critical"].includes(finding.severity)).length,
        0,
      ),
    },
    measurement_gaps: {
      human_review_time_ms: null,
      substantive_human_corrections: null,
      reason: "No human review session is part of the automated benchmark run.",
    },
    claim_boundary:
      "Five bounded tasks can compare this harness with its one-agent baseline, but cannot establish a universal quality or productivity advantage.",
    runs: records,
  };
}

function observationErrors(observation, task) {
  const errors = [];
  if (!isPlainObject(observation)) return ["condition result must be an object"];
  if (observation.task_id !== task.id) errors.push("condition result task_id does not match the manifest");
  if (observation.base_sha !== BENCHMARK_BASE_SHA) {
    errors.push(`condition result base_sha must equal the policy-pinned SHA ${BENCHMARK_BASE_SHA}`);
  }
  if (!TERMINAL_STATUSES.has(observation.terminal_status)) {
    errors.push("condition result terminal_status is not recognized");
  } else if (observation.success !== (observation.terminal_status === "COMPLETE")) {
    errors.push("condition result success must match terminal_status COMPLETE");
  }
  for (const key of [
    "success",
    "implementation_gate_passed",
    "required_checks_passed",
    "verifier_catch",
  ]) {
    if (typeof observation[key] !== "boolean") errors.push(`condition result ${key} must be boolean`);
  }
  for (const key of ["failed_checks", "changed_files", "unnecessary_files"]) {
    if (!Array.isArray(observation[key]) || !observation[key].every(nonEmptyString)) {
      errors.push(`condition result ${key} must be a string array`);
    }
  }
  if (
    Array.isArray(observation.changed_files) &&
    Array.isArray(observation.unnecessary_files)
  ) {
    const expected = observation.changed_files.filter((file) => !task.files_expected.includes(file));
    if (!sameArray(observation.unnecessary_files, expected)) {
      errors.push("condition result unnecessary_files does not match changed_files");
    }
  }
  if (
    typeof observation.implementation_gate_passed === "boolean" &&
    typeof observation.required_checks_passed === "boolean" &&
    observation.verifier_catch !==
      (observation.implementation_gate_passed && !observation.required_checks_passed)
  ) {
    errors.push("condition result verifier_catch is inconsistent with its gates");
  }
  for (const key of [
    "wall_time_ms",
    "time_to_verification_ms",
    "verification_commands_duration_ms",
    "review_time_ms",
  ]) {
    const value = observation[key];
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      errors.push(`condition result ${key} must be null or a non-negative number`);
    }
  }
  if (!isPlainObject(observation.usage)) {
    errors.push("condition result usage is required");
  } else {
    for (const key of ["input_tokens", "output_tokens", "cost_usd", "turns"]) {
      if (!Number.isFinite(observation.usage[key]) || observation.usage[key] < 0) {
        errors.push(`condition result usage.${key} must be a non-negative number`);
      }
    }
  }
  if (!nonEmptyString(observation.receipt_path)) {
    errors.push("condition result receipt_path is required");
  }
  if (observation.qodo_review !== null) {
    const review = observation.qodo_review;
    if (!isPlainObject(review)) {
      errors.push("condition result qodo_review must be null or an object");
    } else {
      if (!["approve", "request_changes"].includes(review.decision)) {
        errors.push("condition result qodo_review.decision is invalid");
      }
      if (typeof review.evidence_sufficient !== "boolean") {
        errors.push("condition result qodo_review.evidence_sufficient must be boolean");
      }
      if (!Array.isArray(review.findings)) errors.push("condition result qodo_review.findings must be an array");
      else {
        for (const finding of review.findings) {
          if (
            !isPlainObject(finding) ||
            !["low", "medium", "high", "critical"].includes(finding.severity) ||
            !nonEmptyString(finding.summary) ||
            !nonEmptyString(finding.file)
          ) {
            errors.push("condition result qodo_review contains an invalid finding");
            break;
          }
        }
      }
      if (!Array.isArray(review.skipped_checks)) {
        errors.push("condition result qodo_review.skipped_checks must be an array");
      } else if (!review.skipped_checks.every(nonEmptyString)) {
        errors.push("condition result qodo_review.skipped_checks must contain strings");
      }
      if (review.duration_ms !== null && (!Number.isFinite(review.duration_ms) || review.duration_ms < 0)) {
        errors.push("condition result qodo_review.duration_ms must be null or a non-negative number");
      }
    }
  }
  return errors;
}

function recordPath(benchmarkDir, index, taskId, condition) {
  return path.join(
    benchmarkDir,
    "results",
    `${String(index + 1).padStart(2, "0")}-${safeId(taskId, "task id")}-${condition}.json`,
  );
}

function sameConfig(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function benchmarkVerificationErrors(task, projectRoot) {
  const errors = [];
  const expectedOracle = TASK_ORACLES.get(task.id);
  if (!expectedOracle) errors.push(`task ${task.id} is not in the benchmark policy`);
  if (!isPlainObject(task.repository)) {
    errors.push("benchmark tasks must use a repository source");
  } else {
    if (task.repository.repo_full_name !== BENCHMARK_REPOSITORY) {
      errors.push(`benchmark task repository must be ${BENCHMARK_REPOSITORY}`);
    }
    if (task.repository.url !== BENCHMARK_REPOSITORY_URL) {
      errors.push(`benchmark task repository URL must be ${BENCHMARK_REPOSITORY_URL}`);
    }
    if (task.repository.clone_ref !== BENCHMARK_CLONE_REF) {
      errors.push(`benchmark task clone_ref must be ${BENCHMARK_CLONE_REF}`);
    }
    if (task.repository.base_ref !== BENCHMARK_BASE_REF) {
      errors.push(`benchmark task base_ref must be ${BENCHMARK_BASE_REF}`);
    }
    if (task.repository.expected_base_sha !== BENCHMARK_BASE_SHA) {
      errors.push(`benchmark task expected_base_sha must be ${BENCHMARK_BASE_SHA}`);
    }
  }
  const checks = new Map(task.verification.map((check) => [check.id, check]));
  if (checks.size !== task.verification.length) errors.push("verification check IDs must be unique");
  const requiredIds = ["held-out-oracle", ...STANDARD_VERIFICATION.keys()];
  if (
    checks.size !== requiredIds.length ||
    requiredIds.some((id) => !checks.has(id))
  ) {
    errors.push(`verification checks must be exactly: ${requiredIds.join(", ")}`);
  }

  const oracle = checks.get("held-out-oracle");
  if (oracle) {
    const argv = oracle.argv;
    const oracleTemplate = argv?.[2];
    const oraclePrefix = "{harness_root}/oracles/";
    if (
      oracle.required !== true ||
      argv?.length !== 4 ||
      argv[0] !== "node" ||
      argv[1] !== "--experimental-strip-types" ||
      typeof oracleTemplate !== "string" ||
      !oracleTemplate.startsWith(oraclePrefix) ||
      !/^[a-z0-9-]+\.mjs$/.test(oracleTemplate.slice(oraclePrefix.length)) ||
      oracleTemplate.slice(oraclePrefix.length) !== expectedOracle ||
      argv[3] !== "."
    ) {
      errors.push("held-out-oracle command is outside the benchmark allowlist");
    } else {
      const oraclePath = path.resolve(
        projectRoot,
        "oracles",
        oracleTemplate.slice(oraclePrefix.length),
      );
      const oracleRoot = path.resolve(projectRoot, "oracles");
      if (!oraclePath.startsWith(`${oracleRoot}${path.sep}`)) {
        errors.push("held-out-oracle path escapes the oracle directory");
      } else {
        try {
          await assertRegularFileWithinRoot(oraclePath, oracleRoot, "held-out oracle");
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  for (const [id, expectedArgv] of STANDARD_VERIFICATION) {
    const check = checks.get(id);
    if (check && (check.required !== true || !sameArray(check.argv, expectedArgv))) {
      errors.push(`${id} command is outside the benchmark allowlist`);
    }
  }
  return errors;
}

function benchmarkIdNow() {
  return `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-").toLowerCase()}-${randomUUID().slice(0, 8)}`;
}

export async function runBenchmark({
  projectRoot,
  suitePath,
  config,
  executeCondition,
  benchmarkId = benchmarkIdNow(),
  resumeDir = null,
}) {
  if (typeof executeCondition !== "function") throw new Error("executeCondition is required");
  const safeSuitePath = await assertRegularFileWithinRoot(
    suitePath,
    projectRoot,
    "benchmark suite",
  );
  const suiteSource = await readFile(safeSuitePath, "utf8");
  const suite = JSON.parse(suiteSource);
  const suiteContract = validateBenchmarkSuite(suite);
  if (!suiteContract.ok) {
    throw new Error(`Invalid benchmark suite: ${suiteContract.errors.join("; ")}`);
  }

  const schedule = buildSchedule(suite);
  const tasks = new Map();
  const taskManifests = [];
  for (const entry of suite.tasks) {
    const taskPath = resolveProjectFile(projectRoot, entry.manifest);
    const safeTaskPath = await assertRegularFileWithinRoot(
      taskPath,
      projectRoot,
      "benchmark task manifest",
    );
    const taskSource = await readFile(safeTaskPath, "utf8");
    const taskValue = JSON.parse(taskSource);
    const taskContract = validateTask(taskValue);
    if (!taskContract.ok) {
      throw new Error(`Invalid task manifest ${entry.manifest}: ${taskContract.errors.join("; ")}`);
    }
    const policyErrors = await benchmarkVerificationErrors(taskValue, projectRoot);
    if (policyErrors.length > 0) {
      throw new Error(`Unsafe benchmark task ${entry.manifest}: ${policyErrors.join("; ")}`);
    }
    safeId(taskValue.id, "task id");
    const manifestSha256 = createHash("sha256").update(taskSource).digest("hex");
    tasks.set(entry.manifest, { task: taskValue, taskPath: safeTaskPath, manifestSha256 });
    taskManifests.push({ path: entry.manifest, task_id: taskValue.id, sha256: manifestSha256 });
  }
  const loadedTaskIds = taskManifests.map((manifest) => manifest.task_id);
  if (
    new Set(loadedTaskIds).size !== TASK_ORACLES.size ||
    [...TASK_ORACLES.keys()].some((taskId) => !loadedTaskIds.includes(taskId))
  ) {
    throw new Error("Benchmark suite must map exactly once to every policy task ID");
  }

  const suiteSha256 = createHash("sha256").update(suiteSource).digest("hex");
  const benchmarkRoot = path.resolve(projectRoot, ".factory-runs", "benchmarks");
  const benchmarkDir = resumeDir
    ? path.resolve(resumeDir)
    : path.join(benchmarkRoot, safeId(benchmarkId, "benchmark id"));
  if (
    path.dirname(benchmarkDir) !== benchmarkRoot ||
    safeId(path.basename(benchmarkDir), "benchmark directory") !== path.basename(benchmarkDir)
  ) {
    throw new Error(`benchmark directory must be a direct child of ${benchmarkRoot}`);
  }
  const metadataPath = path.join(benchmarkDir, "metadata.json");
  const summaryPath = path.join(benchmarkDir, "summary.json");
  const resultsDir = path.join(benchmarkDir, "results");
  const writeCheckpoint = async (file, value) => {
    await assertCheckpointDirectory(path.dirname(file), benchmarkRoot);
    await atomicWriteJson(file, value);
  };
  let metadata;

  if (resumeDir) {
    await assertCheckpointDirectory(benchmarkDir, benchmarkRoot);
    metadata = await readJson(metadataPath, "benchmark metadata").catch((error) => {
      throw new Error(`Cannot resume benchmark without valid metadata at ${metadataPath}: ${error.message}`);
    });
    if (
      metadata.schema_version !== METADATA_SCHEMA ||
      metadata.suite_sha256 !== suiteSha256 ||
      metadata.suite_id !== suite.id ||
      metadata.expected_runs !== schedule.length ||
      JSON.stringify(metadata.task_manifests) !== JSON.stringify(taskManifests) ||
      !sameConfig(metadata.config ?? {}, config)
    ) {
      throw new Error("Resume rejected because the suite or runtime configuration does not match");
    }
  } else {
    await ensureRealDirectory(path.dirname(benchmarkRoot), "factory run root");
    await ensureRealDirectory(benchmarkRoot, "benchmark root");
    try {
      await mkdir(benchmarkDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error(`Benchmark already exists at ${benchmarkDir}; use --resume to continue it`);
      }
      throw error;
    }
    await assertCheckpointDirectory(benchmarkDir, benchmarkRoot);
    metadata = {
      schema_version: METADATA_SCHEMA,
      benchmark_id: benchmarkId,
      suite_id: suite.id,
      suite_sha256: suiteSha256,
      task_manifests: taskManifests,
      expected_runs: schedule.length,
      config,
      started_at: new Date().toISOString(),
    };
    await writeCheckpoint(metadataPath, metadata);
  }
  await mkdir(resultsDir, { recursive: true, mode: 0o700 });
  await assertCheckpointDirectory(resultsDir, benchmarkRoot);

  const committed = [];
  let expectedBaseSha = null;
  for (const [index, entry] of schedule.entries()) {
    const { task, taskPath, manifestSha256 } = tasks.get(entry.manifest);
    const outputPath = recordPath(benchmarkDir, index, task.id, entry.condition);
    const existing = await readJsonIfPresent(outputPath, "benchmark condition record");
    if (existing) {
      const payloadErrors = observationErrors(existing, task);
      if (
        existing.schema_version !== RECORD_SCHEMA ||
        existing.order_index !== index ||
        existing.task_id !== task.id ||
        existing.condition !== entry.condition ||
        existing.task_manifest_sha256 !== manifestSha256 ||
        payloadErrors.length > 0
      ) {
        const detail = payloadErrors.length > 0 ? `: ${payloadErrors.join("; ")}` : "";
        throw new Error(`Resume rejected malformed or mismatched record at ${outputPath}${detail}`);
      }
      if (expectedBaseSha && existing.base_sha !== expectedBaseSha) {
        throw new Error(`Benchmark base revision changed at ${outputPath}`);
      }
      expectedBaseSha = existing.base_sha;
      committed.push(existing);
      continue;
    }

    let observation;
    try {
      observation = await executeCondition({
        condition: entry.condition,
        category: entry.category,
        task,
        taskPath,
        orderIndex: index,
      });
    } catch (error) {
      throw new Error(
        `Benchmark interrupted during ${task.id}/${entry.condition}: ${error instanceof Error ? error.message : String(error)}. Checkpoints remain in ${benchmarkDir}. Resume with --resume ${benchmarkDir}`,
      );
    }
    const errors = observationErrors(observation, task);
    const schedulerOwned = [
      "schema_version",
      "order_index",
      "category",
      "condition",
      "task_manifest_sha256",
    ].filter((key) => Object.hasOwn(observation, key));
    if (schedulerOwned.length > 0) {
      errors.push(`condition result contains scheduler-owned fields: ${schedulerOwned.join(", ")}`);
    }
    if (errors.length > 0) throw new Error(`Invalid condition result: ${errors.join("; ")}`);
    if (expectedBaseSha && observation.base_sha !== expectedBaseSha) {
      throw new Error(
        `Benchmark base revision changed from ${expectedBaseSha} to ${observation.base_sha}; refusing to mix results`,
      );
    }
    expectedBaseSha = observation.base_sha;
    const record = {
      ...observation,
      schema_version: RECORD_SCHEMA,
      order_index: index,
      category: entry.category,
      condition: entry.condition,
      task_manifest_sha256: manifestSha256,
    };
    await writeCheckpoint(outputPath, record);
    committed.push(record);
    await writeCheckpoint(summaryPath, summarizeBenchmark(metadata, committed));
  }

  const summary = summarizeBenchmark(metadata, committed);
  await writeCheckpoint(summaryPath, summary);
  return { benchmarkDir, metadataPath, summaryPath, summary };
}

export async function observationFromRun({ projectRoot, task, condition, runResult }) {
  const { receipt, runDir, artifactsDir } = runResult;
  const verification = receipt.artifact_paths?.verification
    ? await readJson(
        await resolveRunArtifact(runDir, receipt.artifact_paths.verification, "verification"),
        "verification artifact",
      )
    : null;
  const implementationGate =
    condition === "baseline"
      ? receipt.gates?.implementation?.ok === true
      : receipt.gates?.find((gate) => gate.name === "implementation")?.passed === true;
  const verificationGate =
    condition === "baseline"
      ? receipt.gates?.verification?.passed === true
      : receipt.gates?.find((gate) => gate.name === "verification")?.passed === true;
  const failedChecks = verification
    ? verification.checks
        .filter((check) => check.required && check.exit_code !== 0)
        .map((check) => check.id)
    : [];
  const artifactChecksPassed =
    verification !== null &&
    verification.checks.every((check) => !check.required || check.exit_code === 0);
  if (verificationGate !== artifactChecksPassed) {
    throw new Error(
      `Verification gate and artifact disagree for ${task.id}: gate=${verificationGate}, artifact=${artifactChecksPassed}`,
    );
  }
  const changedFiles = receipt.verified_subject?.changed_files ?? verification?.changed_files ?? [];
  const baselineUsage = receipt.usage ?? {};
  const usage = {
    input_tokens: baselineUsage.input_tokens ?? baselineUsage.input ?? 0,
    output_tokens: baselineUsage.output_tokens ?? baselineUsage.output ?? 0,
    cost_usd: baselineUsage.cost_usd ?? 0,
    turns: baselineUsage.turns ?? 0,
  };
  let qodoReview = null;
  if (condition === "factory" && receipt.artifact_paths?.review) {
    const review = await readJson(
      await resolveRunArtifact(runDir, receipt.artifact_paths.review, "review"),
      "review artifact",
    );
    const reviewerEvidence = await readRunJsonIfPresent(
      runDir,
      path.relative(runDir, path.join(artifactsDir, "agents", "reviewer.json")),
      "reviewer evidence",
    );
    qodoReview = {
      decision: review.decision,
      evidence_sufficient: review.evidence_sufficient,
      findings: review.findings,
      skipped_checks: review.skipped_checks,
      duration_ms: reviewerEvidence?.command?.duration_ms ?? receipt.review_time_ms ?? null,
    };
  }
  return {
    task_id: task.id,
    base_sha: receipt.base_sha,
    terminal_status: receipt.terminal_status,
    success: receipt.success,
    implementation_gate_passed: implementationGate,
    required_checks_passed: artifactChecksPassed,
    failed_checks: failedChecks,
    verifier_catch: implementationGate && !artifactChecksPassed,
    wall_time_ms: receipt.wall_time_ms,
    time_to_verification_ms: receipt.time_to_verification_ms ?? null,
    verification_commands_duration_ms: receipt.verification_commands_duration_ms ?? null,
    review_time_ms: receipt.review_time_ms ?? null,
    usage,
    changed_files: changedFiles,
    unnecessary_files: changedFiles.filter((file) => !task.files_expected.includes(file)),
    receipt_path: path.relative(projectRoot, path.join(artifactsDir, "receipt.json")),
    qodo_review: qodoReview,
  };
}
