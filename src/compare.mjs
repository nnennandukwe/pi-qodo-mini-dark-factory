#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function parseFlags(tokens) {
  const flags = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("Expected --multi, --baseline, and --output");
    flags[name.slice(2)] = value;
  }
  return flags;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function percentDelta(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline) || baseline === 0) return null;
  return Math.round(((current - baseline) / baseline) * 1_000) / 10;
}

const flags = parseFlags(process.argv.slice(2));
if (!flags.multi || !flags.baseline || !flags.output) {
  throw new Error("Usage: node src/compare.mjs --multi <receipt> --baseline <receipt> --output <json>");
}

const multiPath = path.resolve(flags.multi);
const baselinePath = path.resolve(flags.baseline);
const [multi, baseline] = await Promise.all([readJson(multiPath), readJson(baselinePath)]);
const multiVerification = await readJson(
  path.join(path.dirname(path.dirname(multiPath)), multi.artifact_paths.verification),
);
const baselineVerification = await readJson(
  path.join(path.dirname(path.dirname(baselinePath)), baseline.artifact_paths.verification),
);
const acceptance = await readJson(path.resolve("evidence/v1/scripted-acceptance.json"));

const requiredChecksPassed = (verification) =>
  verification.checks.every((check) => !check.required || check.exit_code === 0);
const multiAllGatesPassed = multi.gates.every((gate) => gate.passed);
const graduate =
  acceptance.passed &&
  multi.success &&
  multiAllGatesPassed &&
  requiredChecksPassed(multiVerification) &&
  baseline.success &&
  requiredChecksPassed(baselineVerification);

const comparison = {
  schema_version: "mini-dark-factory-comparison/v1",
  generated_at: new Date().toISOString(),
  task_id: multi.task_id,
  pinned_runtime: {
    node: acceptance.node_version,
    pi: acceptance.pi_version,
    provider: "openai-codex",
    model: "gpt-5.5",
    thinking: "medium",
  },
  multi_agent: {
    run_id: multi.run_id,
    terminal_status: multi.terminal_status,
    wall_time_ms: multi.wall_time_ms,
    cost_usd: multi.usage.cost_usd,
    input_tokens: multi.usage.input_tokens,
    output_tokens: multi.usage.output_tokens,
    turns: multi.usage.turns,
    changed_files: multi.verified_subject.changed_files,
    structured_plan: true,
    independent_review: true,
    required_checks_passed: requiredChecksPassed(multiVerification),
  },
  one_agent: {
    run_id: baseline.run_id,
    terminal_status: baseline.terminal_status,
    wall_time_ms: baseline.wall_time_ms,
    cost_usd: baseline.usage.cost_usd,
    input_tokens: baseline.usage.input,
    output_tokens: baseline.usage.output,
    turns: baseline.usage.turns,
    changed_files: baseline.verified_subject.changed_files,
    structured_plan: false,
    independent_review: false,
    required_checks_passed: requiredChecksPassed(baselineVerification),
  },
  overhead: {
    wall_time_percent: percentDelta(multi.wall_time_ms, baseline.wall_time_ms),
    cost_percent: percentDelta(multi.usage.cost_usd, baseline.usage.cost_usd),
    input_tokens_percent: percentDelta(multi.usage.input_tokens, baseline.usage.input),
    output_tokens_percent: percentDelta(multi.usage.output_tokens, baseline.usage.output),
  },
  graduation: {
    graduate_to_qodo_v2: graduate,
    basis: graduate
      ? "The live multi-role workflow completed with current exact-subject evidence, every planted controller failure failed closed, and the same task passed the one-agent baseline."
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
