import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateImplementationReport, validateTask } from "./contracts.mjs";
import { hasCompleteUsage } from "./usage.mjs";
import { changedFiles, patchEvidence, prepareTaskRepository } from "./git.mjs";
import { commandFailure, commandSucceeded, IncompleteProcessEvidenceError, runCommand } from "./process.mjs";

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function runBaseline({ projectRoot, taskPath, runner, runtime = null, verificationTimeoutMs = 180_000 }) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const task = JSON.parse(await readFile(taskPath, "utf8"));
  const taskContract = validateTask(task);
  if (!taskContract.ok) throw new Error(`Invalid task manifest: ${taskContract.errors.join("; ")}`);

  const runId = `${startedAt.replaceAll(":", "-").replaceAll(".", "-")}-${randomUUID().slice(0, 8)}-baseline`;
  const runDir = path.join(projectRoot, ".factory-runs", runId);
  const repoDir = path.join(runDir, "repo");
  const artifactsDir = path.join(runDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const baseSha = await prepareTaskRepository({ projectRoot, task, destination: repoDir });
  await writeJson(path.join(artifactsDir, "task.json"), task);

  process.stderr.write(`\n=== BASELINE STATE ===\n${JSON.stringify({ run_id: runId, status: "RUNNING" }, null, 2)}\n`);
  const finishFailure = async (status, reason, agentEvidence = null) => {
    const complete = hasCompleteUsage(agentEvidence);
    const receipt = {
      schema_version: "mini-dark-factory-baseline-receipt/v1", run_id: runId,
      task_id: task.id, terminal_status: status, success: false, runtime,
      started_at: startedAt, finished_at: new Date().toISOString(),
      wall_time_ms: Math.round(performance.now() - started), base_sha: baseSha,
      reason, recovery: status === "AGENT_FAILED"
        ? "Fix the agent runtime error shown above and rerun baseline."
        : "Resolve the reported timeout or reduce output with a smaller patch, then rerun implementation and verification.",
      usage: complete ? agentEvidence.usage : null, usage_complete: complete,
      artifact_paths: { task: "artifacts/task.json" },
    };
    await writeJson(path.join(artifactsDir, "receipt.json"), receipt);
    return { receipt, runDir, artifactsDir };
  };
  let agentResult;
  try {
    agentResult = await runner.run("baseline", { cwd: repoDir, input: { task } });
  } catch (error) {
    return finishFailure("AGENT_FAILED", error instanceof Error ? error.message : String(error));
  }

  try {
    await writeJson(path.join(artifactsDir, "agent.json"), agentResult.evidence);
    await writeJson(path.join(artifactsDir, "implementation.json"), agentResult.output);
    const actualChangedFiles = await changedFiles(repoDir, baseSha);
    const implementationGate = validateImplementationReport(agentResult.output, task, actualChangedFiles);

    const toolPath = path.join(projectRoot, "node_modules", ".bin");
    const verificationEnv = { ...process.env, PATH: `${toolPath}:${process.env.PATH ?? ""}` };
    const checks = [];
    const verificationStarted = performance.now();
    for (const check of task.verification) {
      const argv = check.argv.map((part) => part.replaceAll("{harness_root}", projectRoot));
      checks.push({
        id: check.id,
        required: check.required,
        ...(await runCommand(argv, { cwd: repoDir, env: verificationEnv, timeoutMs: verificationTimeoutMs })),
      });
    }
    const verificationCommandsDurationMs = Math.round(performance.now() - verificationStarted);
    const timeToVerificationMs = Math.round(performance.now() - started);
    const verification = {
      task_id: task.id, base_sha: baseSha, patch_digest: null,
      changed_files: actualChangedFiles, checks, evidence_complete: false,
    };
    await writeJson(path.join(artifactsDir, "verification.json"), verification);
    const evidence = await patchEvidence(repoDir, baseSha);
    await writeFile(path.join(artifactsDir, "diff.patch"), evidence.patch);
    verification.patch_digest = evidence.digest;
    verification.evidence_complete = true;
    await writeJson(path.join(artifactsDir, "verification.json"), verification);

    const failedChecks = checks.filter((check) => check.required && !commandSucceeded(check));
    const success = implementationGate.ok && failedChecks.length === 0;
    const receipt = {
      schema_version: "mini-dark-factory-baseline-receipt/v1",
      run_id: runId,
      task_id: task.id,
      terminal_status: success ? "COMPLETE" : "FAILED",
      success,
      runtime,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      wall_time_ms: Math.round(performance.now() - started),
      time_to_verification_ms: timeToVerificationMs,
      verification_commands_duration_ms: verificationCommandsDurationMs,
      review_time_ms: null,
      base_sha: baseSha,
      verified_subject: {
        base_sha: baseSha,
        patch_digest: evidence.digest,
        changed_files: actualChangedFiles,
      },
      gates: {
        implementation: implementationGate,
        verification: {
          passed: failedChecks.length === 0,
          failed_checks: failedChecks.map((check) => check.id),
          reasons: failedChecks.map((check) => `${check.id}: ${commandFailure(check)}`),
        },
      },
      usage: hasCompleteUsage(agentResult.evidence) ? agentResult.evidence.usage : null,
      usage_complete: hasCompleteUsage(agentResult.evidence),
      artifact_paths: {
        task: "artifacts/task.json",
        implementation: "artifacts/implementation.json",
        verification: "artifacts/verification.json",
        diff: "artifacts/diff.patch",
        agent: "artifacts/agent.json",
      },
    };
    await writeJson(path.join(artifactsDir, "receipt.json"), receipt);
    process.stderr.write(`\n=== BASELINE STATE ===\n${JSON.stringify({ run_id: runId, status: receipt.terminal_status }, null, 2)}\n`);
    return { receipt, runDir, artifactsDir };
  } catch (error) {
    if (!(error instanceof IncompleteProcessEvidenceError)) throw error;
    return finishFailure("FAILED", error.message, agentResult.evidence);
  }
}
