#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runBaseline } from "./baseline.mjs";
import { observationFromRun, runBenchmark } from "./benchmark.mjs";
import { validateTask } from "./contracts.mjs";
import { runPilot } from "./controller.mjs";
import { assertPiAvailable, PiRunner } from "./pi-runner.mjs";
import { runCommand } from "./process.mjs";
import { QodoReviewer } from "./qodo-runner.mjs";
import { retryReview } from "./review-retry.mjs";
import { ScriptedRunner } from "./scripted-runner.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultTask = path.join(projectRoot, "tasks", "reject-expired-session-token.json");
const defaultBenchmarkSuite = path.join(projectRoot, "tasks", "benchmark-suite.json");

const HELP = `Pi x Qodo Mini Dark Factory v2

Usage:
  node src/cli.mjs acceptance
  node src/cli.mjs baseline --provider <provider> --model <model> [--thinking <level>]
  node src/cli.mjs benchmark --provider <provider> --model <model> [--resume <benchmark-directory>]
  node src/cli.mjs run --runner scripted [--scenario <name>]
  node src/cli.mjs run --runner pi --provider <provider> --model <model> [--thinking <level>]
  node src/cli.mjs run --runner pi --reviewer qodo --task <manifest> --provider <provider> --model <model>
  node src/cli.mjs retry-review --run-dir <failed-run-directory> [--qodo-depth <level>]

Commands:
  acceptance  Exercise the happy path and all planted gate failures.
  baseline    Run the same task through one Pi coding agent.
  benchmark   Run the counterbalanced five-task baseline and Pi + Qodo comparison.
  run         Execute one scripted, live Pi, or Pi + Qodo workflow.
  retry-review  Retry only Qodo against an unchanged, previously verified patch.

Live prerequisite:
  Start pi, run /login openai-codex, then verify with:
  pi auth check --provider openai-codex --json

Qodo options:
  --reviewer qodo       Use Qodo for semantic review after deterministic verification.
  --qodo-depth <level>  Reproducible review depth: fast (default) or deep.
  --qodo-bin <path>     Override the Qodo executable.

Retry options:
  --run-dir <path>      REVIEWER_FAILED run whose verified patch should be reviewed.
  --attempt-id <id>     Optional unique diagnostic ID; omit to generate one safely.

Benchmark options:
  --suite <path>        Benchmark suite manifest; defaults to tasks/benchmark-suite.json.
  --resume <path>       Resume a benchmark from its durable condition checkpoints.
`;

const COMMAND_FLAGS = Object.freeze({
  acceptance: new Set(),
  baseline: new Set(["provider", "model", "thinking", "pi-bin", "task"]),
  benchmark: new Set([
    "provider",
    "model",
    "thinking",
    "pi-bin",
    "qodo-bin",
    "qodo-depth",
    "suite",
    "resume",
  ]),
  run: new Set([
    "runner",
    "scenario",
    "provider",
    "model",
    "thinking",
    "pi-bin",
    "qodo-bin",
    "qodo-depth",
    "reviewer",
    "task",
    "quiet",
  ]),
  "retry-review": new Set(["run-dir", "qodo-bin", "qodo-depth", "attempt-id"]),
});

function parseFlags(tokens, command) {
  const flags = {};
  const allowed = COMMAND_FLAGS[command];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown option for ${command}: --${name}`);
    const value = tokens[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
    flags[name] = value;
    index += 1;
  }
  return flags;
}

async function makeRunner(flags, task) {
  const runnerName = flags.runner ?? "scripted";
  if (runnerName === "scripted") {
    return {
      runnerName,
      scenario: flags.scenario ?? "happy",
      runner: new ScriptedRunner({ scenario: flags.scenario ?? "happy" }),
    };
  }
  if (runnerName === "pi") {
    const reviewerName = flags.reviewer ?? "pi";
    if (!["pi", "qodo"].includes(reviewerName)) {
      throw new Error(`Unknown reviewer: ${reviewerName}`);
    }
    if (!flags.provider || !flags.model) {
      throw new Error("Live Pi runs require both --provider and --model so the trial is reproducible");
    }
    const installed = await assertPiAvailable(flags["pi-bin"] ?? "pi");
    process.stderr.write(`Pi runtime: ${JSON.stringify(installed)}\n`);
    const reviewer =
      reviewerName === "qodo"
        ? new QodoReviewer({
            qodoBin: flags["qodo-bin"] ?? "qodo",
            depth: flags["qodo-depth"] ?? "fast",
          })
        : null;
    if (reviewer) {
      const preflight = await reviewer.preflight({ cwd: projectRoot, repository: task.repository });
      process.stderr.write(`Qodo runtime: ${JSON.stringify(preflight)}\n`);
    }
    return {
      runnerName,
      reviewerName,
      scenario: null,
      runner: new PiRunner({
        projectRoot,
        provider: flags.provider,
        model: flags.model,
        thinking: flags.thinking ?? "medium",
        piBin: flags["pi-bin"] ?? "pi",
      }),
      reviewer,
    };
  }
  throw new Error(`Unknown runner: ${runnerName}`);
}

async function runOnce(flags) {
  const taskPath = path.resolve(flags.task ?? defaultTask);
  const task = JSON.parse(await readFile(taskPath, "utf8"));
  const taskContract = validateTask(task);
  if (!taskContract.ok) {
    throw new Error(`Invalid task manifest: ${taskContract.errors.join("; ")}`);
  }
  const selected = await makeRunner(flags, task);
  const result = await runPilot({
    projectRoot,
    taskPath,
    ...selected,
  });
  if (!flags.quiet) {
    process.stdout.write(
      `${JSON.stringify({
        terminal_status: result.receipt.terminal_status,
        success: result.receipt.success,
        receipt: path.join(result.artifactsDir, "receipt.json"),
      })}\n`,
    );
  }
  return result;
}

async function acceptance() {
  const expectations = [
    ["happy", "COMPLETE"],
    ["plan-missing-non-goals", "PLAN_REJECTED"],
    ["out-of-scope", "IMPLEMENTATION_REJECTED"],
    ["verification-fail", "VERIFICATION_FAILED"],
    ["post-verification-mutation", "EVIDENCE_STALE"],
    ["review-time-mutation", "EVIDENCE_STALE"],
    ["review-changes", "CHANGES_REQUESTED"],
  ];
  const results = [];
  for (const [scenario, expected] of expectations) {
    const result = await runOnce({ runner: "scripted", scenario, quiet: true });
    const actual = result.receipt.terminal_status;
    results.push({ scenario, expected, actual, passed: actual === expected, run_dir: result.runDir });
  }
  const summary = {
    generated_at: new Date().toISOString(),
    node_version: process.version,
    pi_version: (await assertPiAvailable()).cli_version,
    passed: results.every((result) => result.passed),
    scenarios: results,
  };
  const evidenceDir = path.join(projectRoot, "evidence");
  const summaryPath = path.join(evidenceDir, "v1", "scripted-acceptance.json");
  await mkdir(path.dirname(summaryPath), { recursive: true });
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...summary, evidence: summaryPath })}\n`);
  if (!summary.passed) process.exitCode = 1;
}

async function baseline(flags) {
  if (!flags.provider || !flags.model) {
    throw new Error("Baseline runs require both --provider and --model");
  }
  const installed = await assertPiAvailable(flags["pi-bin"] ?? "pi");
  process.stderr.write(`Pi runtime: ${JSON.stringify(installed)}\n`);
  const runner = new PiRunner({
    projectRoot,
    provider: flags.provider,
    model: flags.model,
    thinking: flags.thinking ?? "medium",
    piBin: flags["pi-bin"] ?? "pi",
  });
  const result = await runBaseline({
    projectRoot,
    taskPath: path.resolve(flags.task ?? defaultTask),
    runner,
  });
  process.stdout.write(
    `${JSON.stringify({
      terminal_status: result.receipt.terminal_status,
      success: result.receipt.success,
      receipt: path.join(result.artifactsDir, "receipt.json"),
    })}\n`,
  );
}

async function benchmarkCommand(flags) {
  if (!flags.provider || !flags.model) {
    throw new Error("Benchmark runs require both --provider and --model");
  }
  const piBin = flags["pi-bin"] ?? "pi";
  const qodoBin = flags["qodo-bin"] ?? "qodo";
  const qodoDepth = flags["qodo-depth"] ?? "fast";
  const thinking = flags.thinking ?? "medium";
  const installed = await assertPiAvailable(piBin);
  process.stderr.write(`Pi runtime: ${JSON.stringify(installed)}\n`);
  const [revision, status, qodoVersion] = await Promise.all([
    runCommand(["git", "rev-parse", "HEAD"], { cwd: projectRoot }),
    runCommand(["git", "status", "--porcelain"], { cwd: projectRoot }),
    runCommand([qodoBin, "--version"], { cwd: projectRoot }),
  ]);
  if (revision.exit_code !== 0 || status.exit_code !== 0) {
    throw new Error("Benchmark requires a readable Git revision and worktree status");
  }
  if (status.stdout.trim()) {
    throw new Error("Benchmark requires a clean harness worktree so the controller revision is reproducible");
  }
  if (qodoVersion.exit_code !== 0) {
    throw new Error(`Qodo is unavailable: ${qodoVersion.stderr}`);
  }
  const runner = new PiRunner({
    projectRoot,
    provider: flags.provider,
    model: flags.model,
    thinking,
    piBin,
  });
  const reviewer = new QodoReviewer({
    qodoBin,
    depth: qodoDepth,
  });
  const result = await runBenchmark({
    projectRoot,
    suitePath: path.resolve(flags.suite ?? defaultBenchmarkSuite),
    resumeDir: flags.resume ? path.resolve(flags.resume) : null,
    config: {
      provider: flags.provider,
      model: flags.model,
      thinking,
      qodo_depth: qodoDepth,
      node_version: process.version,
      pi_version: installed.cli_version,
      qodo_cli_version: qodoVersion.stdout.trim(),
      qodo_skill_version: "1.9.5",
      harness_revision: revision.stdout.trim(),
    },
    executeCondition: async ({ condition, task, taskPath }) => {
      process.stderr.write(`\n=== BENCHMARK CONDITION ===\n${JSON.stringify({ task_id: task.id, condition }, null, 2)}\n`);
      const runResult =
        condition === "baseline"
          ? await runBaseline({ projectRoot, taskPath, runner })
          : await runPilot({
              projectRoot,
              taskPath,
              runner,
              runnerName: "pi",
              reviewer,
              reviewerName: "qodo",
            });
      return observationFromRun({ projectRoot, task, condition, runResult });
    },
  });
  process.stdout.write(
    `${JSON.stringify({
      complete: result.summary.complete,
      benchmark_dir: result.benchmarkDir,
      summary: result.summaryPath,
    })}\n`,
  );
}

async function retryReviewCommand(flags) {
  if (!flags["run-dir"]) {
    throw new Error("retry-review requires --run-dir pointing to a REVIEWER_FAILED run");
  }
  const reviewer = new QodoReviewer({
    qodoBin: flags["qodo-bin"] ?? "qodo",
    depth: flags["qodo-depth"] ?? "fast",
  });
  const result = await retryReview({
    runDir: path.resolve(flags["run-dir"]),
    reviewer,
    reviewerName: "qodo",
    attemptId: flags["attempt-id"],
  });
  process.stdout.write(
    `${JSON.stringify({
      terminal_status: result.receipt.terminal_status,
      success: result.receipt.success,
      receipt: result.receiptPath,
    })}\n`,
  );
  if (!result.receipt.success) process.exitCode = 1;
}

const [command = "run", ...rest] = process.argv.slice(2);
try {
  if (["help", "--help", "-h"].includes(command)) {
    process.stdout.write(HELP);
  } else {
    if (!Object.hasOwn(COMMAND_FLAGS, command)) throw new Error(`Unknown command: ${command}`);
    const flags = parseFlags(rest, command);
    if (command === "acceptance") await acceptance();
    else if (command === "baseline") await baseline(flags);
    else if (command === "benchmark") await benchmarkCommand(flags);
    else if (command === "run") await runOnce(flags);
    else if (command === "retry-review") await retryReviewCommand(flags);
    else throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\nRun with --help for usage.\n`);
  process.exitCode = 1;
}
