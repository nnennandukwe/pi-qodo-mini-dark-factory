#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateTask } from "./contracts.mjs";
import { patchEvidence } from "./git.mjs";
import { hasCompleteUsage } from "./usage.mjs";
import { commandSucceeded, runCommand } from "./process.mjs";

const HELP = `Usage: node src/compare.mjs --multi <receipt> --baseline <receipt> --output <json>

Compare saved workflow and baseline receipts using their verification evidence.
Receipts must describe the same task contract. Graduation requires complete
verification bound to each receipt's subject and every workflow gate to pass.
`;

function parseFlags(tokens) {
  const flags = {};
  const allowed = new Set(["multi", "baseline", "output"]);
  for (let index = 0; index < tokens.length; index += 2) {
    const token = tokens[index];
    if (["--help", "-h"].includes(token)) return { help: true };
    const name = token?.slice(2);
    if (!token?.startsWith("--") || !allowed.has(name)) {
      throw new Error(`Unknown option: ${token}. Use --help for comparison usage.`);
    }
    const value = tokens[index + 1];
    if (!value || (value.startsWith("--") && allowed.has(value.slice(2)))) throw new Error(`Missing value for ${token}. Use --help for comparison usage.`);
    if (Object.hasOwn(flags, name)) throw new Error(`Repeated option: ${token}. Supply each path once.`);
    flags[name] = value;
  }
  return flags;
}

async function readJson(file) {
  const contents = await readFile(file, "utf8");
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error.message}. Repair this file and retry the comparison.`, { cause: error });
  }
}

async function savedEvidence(receipt, receiptPath) {
  const runDir = path.dirname(path.dirname(receiptPath));
  const readArtifact = async (name) => receipt.artifact_paths?.[name]
    ? readJson(path.join(runDir, receipt.artifact_paths[name]))
    : null;
  const [task, verification] = await Promise.all([readArtifact("task"), readArtifact("verification")]);
  const subject = receipt.verified_subject;
  const matchesSubject = typeof receipt.base_sha === "string" && /^[0-9a-f]{40}$/.test(receipt.base_sha) &&
    typeof subject?.patch_digest === "string" && /^[0-9a-f]{64}$/.test(subject.patch_digest) &&
    subject.base_sha === receipt.base_sha && verification?.base_sha === receipt.base_sha &&
    verification?.task_id === receipt.task_id && verification?.patch_digest === subject.patch_digest &&
    Array.isArray(subject.changed_files) && Array.isArray(verification?.changed_files) &&
    isDeepStrictEqual([...subject.changed_files].sort(), [...verification.changed_files].sort());
  const checks = verification?.checks;
  const harnessRoot = verification?.harness_root ?? path.resolve(runDir, "../..");
  const validTask = validateTask(task).ok && task.id === receipt.task_id &&
    (!task.repository?.expected_base_sha || task.repository.expected_base_sha === receipt.base_sha);
  let fixtureBaseTree = null;
  if (validTask && task.fixture && matchesSubject) {
    const repoDir = path.join(runDir, "repo");
    const tree = await runCommand(["git", "rev-parse", "--verify", `${receipt.base_sha}^{tree}`], { cwd: repoDir });
    if (!commandSucceeded(tree) || !/^[0-9a-f]{40}$/.test(tree.stdout.trim())) {
      throw new Error(`Can't verify fixture base contents in ${repoDir}. Restore the run repository and retry.`);
    }
    fixtureBaseTree = tree.stdout.trim();
  }
  const completeChecks = validTask && typeof harnessRoot === "string" && path.isAbsolute(harnessRoot) &&
    Array.isArray(checks) && checks.every((check) => check && typeof check === "object") &&
    checks.length === task.verification.length && new Set(checks.map((check) => check.id)).size === checks.length &&
    task.verification.every((expected) => {
      const check = checks.find((candidate) => candidate.id === expected.id);
      const expectedArgv = expected.argv.map((part) => part.replaceAll("{harness_root}", harnessRoot));
      return check && check.required === expected.required && isDeepStrictEqual(check.argv, expectedArgv) &&
        (!expected.required || commandSucceeded(check));
    });
  let patchMatches = false;
  if (receipt.artifact_paths?.diff && matchesSubject) {
    const diffPath = path.join(runDir, receipt.artifact_paths.diff);
    const diff = await readFile(diffPath, "utf8");
    const stats = diff.length === 0 ? null
      : await runCommand(["git", "apply", "--numstat", "-z", "--", diffPath], { cwd: runDir });
    const rows = (stats?.stdout ?? "").split("\0").filter(Boolean);
    const validStats = (stats === null || commandSucceeded(stats)) && rows.every((row) => /^(\d+|-)\t(\d+|-)\t.+/s.test(row));
    const patchFiles = rows.map((row) => row.slice(row.indexOf("\t", row.indexOf("\t") + 1) + 1));
    patchMatches = createHash("sha256").update(diff).digest("hex") === subject?.patch_digest;
    if (!patchMatches) {
      // The canonical digest also includes untracked files, which aren't in diff.patch.
      const repoDir = path.join(runDir, "repo");
      let current;
      try {
        current = await patchEvidence(repoDir, receipt.base_sha);
      } catch (error) {
        throw new Error(`Can't verify saved patch evidence in ${repoDir}: ${error.message}. Restore the run repository and retry.`, { cause: error });
      }
      patchMatches = current.patch === diff && current.digest === subject.patch_digest;
      patchFiles.push(...current.untracked_files);
    }
    patchMatches = patchMatches && validStats &&
      isDeepStrictEqual([...new Set(patchFiles)].sort(), [...subject.changed_files].sort());
  }
  return { task, fixtureBaseTree,
    passed: verification?.evidence_complete === true && matchesSubject && Boolean(completeChecks) && patchMatches };
}

function workflowGatesPassed(receipt) {
  const required = ["planner", "implementation", "verification", "evidence_freshness", "evidence_freshness_after_review", "review"];
  return Array.isArray(receipt.gates) && receipt.gates.every((gate) => gate?.passed === true) &&
    required.every((name) => receipt.gates.filter((gate) => gate.name === name).length === 1);
}

function percentDelta(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return null;
  return Math.round(((current - baseline) / baseline) * 1_000) / 10;
}

async function main(tokens) {
  const flags = parseFlags(tokens);
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!flags.multi || !flags.baseline || !flags.output) {
    throw new Error("Usage: node src/compare.mjs --multi <receipt> --baseline <receipt> --output <json>");
  }

  const multiPath = path.resolve(flags.multi);
  const baselinePath = path.resolve(flags.baseline);
  const [multi, baseline] = await Promise.all([readJson(multiPath), readJson(baselinePath)]);
  if (typeof multi?.task_id !== "string" || !multi.task_id.trim() || multi.task_id !== baseline?.task_id) {
    throw new Error("Receipts must describe the same task. Select matching task receipts and retry the comparison.");
  }
  const multiUsage = hasCompleteUsage(multi) ? multi.usage : null;
  const baselineUsage = hasCompleteUsage(baseline) ? baseline.usage : null;
  const [multiEvidence, baselineEvidence] = await Promise.all([
    savedEvidence(multi, multiPath), savedEvidence(baseline, baselinePath),
  ]);
  if (multiEvidence.task && baselineEvidence.task && (!isDeepStrictEqual(multiEvidence.task, baselineEvidence.task) ||
    (multiEvidence.task.repository && multi.base_sha !== baseline.base_sha))) {
    throw new Error("Receipts must use the same task contract and repository base. Select matching task runs and retry the comparison.");
  }
  if (multiEvidence.fixtureBaseTree && baselineEvidence.fixtureBaseTree &&
    multiEvidence.fixtureBaseTree !== baselineEvidence.fixtureBaseTree) {
    throw new Error("Receipts must use matching fixture contents. Select runs from the same fixture version and retry the comparison.");
  }
  const acceptance = await readJson(path.resolve("evidence/v1/scripted-acceptance.json"));
  const sharedRuntime = (field) => multi.runtime?.[field] != null && multi.runtime[field] === baseline.runtime?.[field]
    ? multi.runtime[field] : null;
  const reasons = [];
  if (acceptance?.passed !== true) reasons.push("Rerun scripted acceptance and resolve its failed scenarios.");
  if (multi.success !== true || multi.terminal_status !== "COMPLETE" || !workflowGatesPassed(multi)) {
    reasons.push("The multi-role receipt lacks a complete set of passing gates. Rerun the workflow and resolve its failed gates.");
  }
  if (baseline.success !== true || baseline.terminal_status !== "COMPLETE" ||
    baseline.gates?.implementation?.ok !== true || baseline.gates?.verification?.passed !== true) {
    reasons.push("The baseline receipt lacks passing implementation and verification gates. Rerun the baseline.");
  }
  if (!multiEvidence.passed) reasons.push("Multi-role verification or saved patch evidence is incomplete or doesn't match its task and subject. Rerun implementation and verification.");
  if (!baselineEvidence.passed) reasons.push("Baseline verification or saved patch evidence is incomplete or doesn't match its task and subject. Rerun the baseline.");
  const graduate = reasons.length === 0;

  const comparison = {
    schema_version: "mini-dark-factory-comparison/v1",
    generated_at: new Date().toISOString(),
    task_id: multi.task_id,
    pinned_runtime: {
      node: sharedRuntime("node_version"),
      pi: sharedRuntime("pi_version"),
      provider: sharedRuntime("provider"),
      model: sharedRuntime("model"),
      thinking: sharedRuntime("thinking"),
    },
    multi_agent: {
      run_id: multi.run_id,
      runtime: multi.runtime ?? null,
      terminal_status: multi.terminal_status,
      wall_time_ms: multi.wall_time_ms,
      usage_complete: multiUsage != null,
      cost_usd: multiUsage?.cost_usd ?? null,
      input_tokens: multiUsage?.input_tokens ?? null,
      output_tokens: multiUsage?.output_tokens ?? null,
      turns: multiUsage?.turns ?? null,
      changed_files: multi.verified_subject?.changed_files ?? [],
      structured_plan: true,
      independent_review: true,
      required_checks_passed: multiEvidence.passed,
    },
    one_agent: {
      run_id: baseline.run_id,
      runtime: baseline.runtime ?? null,
      terminal_status: baseline.terminal_status,
      wall_time_ms: baseline.wall_time_ms,
      usage_complete: baselineUsage != null,
      cost_usd: baselineUsage?.cost_usd ?? null,
      input_tokens: baselineUsage?.input ?? null,
      output_tokens: baselineUsage?.output ?? null,
      turns: baselineUsage?.turns ?? null,
      changed_files: baseline.verified_subject?.changed_files ?? [],
      structured_plan: false,
      independent_review: false,
      required_checks_passed: baselineEvidence.passed,
    },
    overhead: {
      wall_time_percent: percentDelta(multi.wall_time_ms, baseline.wall_time_ms),
      cost_percent: percentDelta(multiUsage?.cost_usd, baselineUsage?.cost_usd),
      input_tokens_percent: percentDelta(multiUsage?.input_tokens, baselineUsage?.input),
      output_tokens_percent: percentDelta(multiUsage?.output_tokens, baselineUsage?.output),
    },
    graduation: {
      graduate_to_qodo_v2: graduate,
      reasons,
      basis: graduate
        ? "The multi-role workflow completed with matching saved verification evidence, scripted acceptance passed, and the same task passed the one-agent baseline."
        : "One or more v1 functional or baseline checks did not pass.",
      claim_boundary:
        "This one-task pilot proves workflow control and inspectability. It does not establish a statistically reliable quality advantage over one-agent coding.",
    },
    evidence: {
      scripted_acceptance: "evidence/v1/scripted-acceptance.json",
      multi_receipt: multiPath,
      baseline_receipt: baselinePath,
    },
  };

  const output = path.resolve(flags.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(comparison, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, graduate_to_qodo_v2: graduate })}\n`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\nRun with --help for usage.\n`);
  process.exitCode = 1;
}
