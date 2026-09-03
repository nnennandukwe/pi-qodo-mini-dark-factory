import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  reviewGate,
  validateImplementationReport,
  validatePlan,
  validateReview,
  validateTask,
} from "./contracts.mjs";
import { changedFiles, patchEvidence, prepareTaskRepository } from "./git.mjs";
import { runCommand } from "./process.mjs";
import { createRunState, transition } from "./state-machine.mjs";

function safeTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function renderState(state, latestGate) {
  const view = {
    run_id: state.runId,
    task_id: state.taskId,
    status: state.status,
    latest_gate: latestGate ?? null,
    transition_count: state.history.length,
  };
  process.stderr.write(`\n=== FACTORY STATE ===\n${JSON.stringify(view, null, 2)}\n`);
}

async function existingArtifacts(runDir) {
  const candidates = {
    task: "artifacts/task.json",
    plan: "artifacts/plan.json",
    implementation: "artifacts/implementation.json",
    verification: "artifacts/verification.json",
    review: "artifacts/review.json",
    diff: "artifacts/diff.patch",
    qodo_context: "artifacts/agents/qodo-context.json",
    qodo_result: "artifacts/agents/qodo-review-result.json",
    qodo_progress: "artifacts/agents/qodo-review-progress.ndjson",
  };
  const present = {};
  for (const [name, relativePath] of Object.entries(candidates)) {
    try {
      await access(path.join(runDir, relativePath));
      present[name] = relativePath;
    } catch {
      // Earlier gates intentionally leave later artifacts absent.
    }
  }
  return present;
}

function sumUsage(agentEvidence) {
  return Object.values(agentEvidence).reduce(
    (total, evidence) => {
      const usage = evidence.usage ?? {};
      total.input_tokens += usage.input ?? 0;
      total.output_tokens += usage.output ?? 0;
      total.cost_usd += usage.cost_usd ?? 0;
      total.turns += usage.turns ?? 0;
      return total;
    },
    { input_tokens: 0, output_tokens: 0, cost_usd: 0, turns: 0 },
  );
}

export async function runPilot({
  projectRoot,
  taskPath,
  runner,
  runnerName,
  reviewer = null,
  reviewerName = null,
  scenario = null,
}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const task = JSON.parse(await readFile(taskPath, "utf8"));
  const taskContract = validateTask(task);
  if (!taskContract.ok) throw new Error(`Invalid task manifest: ${taskContract.errors.join("; ")}`);

  const runId = `${safeTimestamp()}-${randomUUID().slice(0, 8)}-${runnerName}`;
  const runDir = path.join(projectRoot, ".factory-runs", runId);
  const repoDir = path.join(runDir, "repo");
  const artifactsDir = path.join(runDir, "artifacts");
  const agentsDir = path.join(artifactsDir, "agents");
  await mkdir(agentsDir, { recursive: true });
  const baseSha = await prepareTaskRepository({ projectRoot, task, destination: repoDir });
  await writeJson(path.join(artifactsDir, "task.json"), task);

  let state = createRunState({ runId, taskId: task.id, startedAt });
  const gates = [];
  const agentEvidence = {};
  let verifiedSubject = null;

  const move = (event, details = {}) => {
    state = transition(state, event, details);
    renderState(state, gates.at(-1));
  };
  const gate = (name, passed, reasons, evidence = {}) => {
    const decision = {
      name,
      passed,
      reasons,
      evidence,
      at: new Date().toISOString(),
    };
    gates.push(decision);
    return decision;
  };
  const finish = async () => {
    const finishedAt = new Date().toISOString();
    const receipt = {
      schema_version: "mini-dark-factory-receipt/v2",
      run_id: runId,
      task_id: task.id,
      runner: runnerName,
      reviewer: reviewerName ?? runnerName,
      scenario,
      terminal_status: state.status,
      success: state.status === "COMPLETE",
      started_at: startedAt,
      finished_at: finishedAt,
      wall_time_ms: Math.round(performance.now() - started),
      base_sha: baseSha,
      verified_subject: verifiedSubject,
      state_history: state.history,
      gates,
      usage: sumUsage(agentEvidence),
      artifact_paths: await existingArtifacts(runDir),
    };
    await writeJson(path.join(artifactsDir, "receipt.json"), receipt);
    return { receipt, runDir, repoDir, artifactsDir };
  };

  renderState(state);
  move("START_PLANNING");
  let plannerResult;
  try {
    plannerResult = await runner.run("planner", { cwd: repoDir, input: { task } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gate("planner_runtime", false, [reason]);
    move("AGENT_FAILED", { role: "planner", reason });
    return finish();
  }
  agentEvidence.planner = plannerResult.evidence;
  await writeJson(path.join(artifactsDir, "plan.json"), plannerResult.output);
  await writeJson(path.join(agentsDir, "planner.json"), plannerResult.evidence);
  const planContract = validatePlan(plannerResult.output, task);
  gate("planner", planContract.ok, planContract.errors, {
    artifact: "artifacts/plan.json",
    mutation_tools_available: false,
  });
  if (!planContract.ok) {
    move("PLAN_REJECTED", { reasons: planContract.errors });
    return finish();
  }
  move("PLAN_ACCEPTED");

  move("START_IMPLEMENTATION");
  let implementerResult;
  try {
    implementerResult = await runner.run("implementer", {
      cwd: repoDir,
      input: { task, approved_plan: plannerResult.output },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gate("implementer_runtime", false, [reason]);
    move("AGENT_FAILED", { role: "implementer", reason });
    return finish();
  }
  agentEvidence.implementer = implementerResult.evidence;
  await writeJson(path.join(artifactsDir, "implementation.json"), implementerResult.output);
  await writeJson(path.join(agentsDir, "implementer.json"), implementerResult.evidence);
  const actualChangedFiles = await changedFiles(repoDir, baseSha);
  const implementationContract = validateImplementationReport(
    implementerResult.output,
    task,
    actualChangedFiles,
  );
  gate("implementation", implementationContract.ok, implementationContract.errors, {
    artifact: "artifacts/implementation.json",
    actual_changed_files: actualChangedFiles,
    allowed_files: task.files_allowed,
  });
  if (!implementationContract.ok) {
    move("IMPLEMENTATION_REJECTED", { reasons: implementationContract.errors });
    return finish();
  }
  move("IMPLEMENTATION_ACCEPTED");

  move("START_VERIFICATION");
  const toolPath = path.join(projectRoot, "node_modules", ".bin");
  const verificationEnv = { ...process.env, PATH: `${toolPath}:${process.env.PATH ?? ""}` };
  const checks = [];
  for (const check of task.verification) {
    const argv = check.argv.map((part) => part.replaceAll("{harness_root}", projectRoot));
    const command = await runCommand(argv, {
      cwd: repoDir,
      env: verificationEnv,
      timeoutMs: 180_000,
    });
    checks.push({ id: check.id, required: check.required, ...command });
  }
  const evidence = await patchEvidence(repoDir, baseSha);
  await writeFile(path.join(artifactsDir, "diff.patch"), evidence.patch);
  const verification = {
    task_id: task.id,
    base_sha: baseSha,
    patch_digest: evidence.digest,
    changed_files: await changedFiles(repoDir, baseSha),
    checks,
  };
  await writeJson(path.join(artifactsDir, "verification.json"), verification);
  const failedRequired = checks.filter((check) => check.required && check.exit_code !== 0);
  gate(
    "verification",
    failedRequired.length === 0,
    failedRequired.map((check) => `${check.id} exited ${check.exit_code}`),
    {
      artifact: "artifacts/verification.json",
      required_checks: checks.filter((check) => check.required).map((check) => check.id),
      patch_digest: evidence.digest,
    },
  );
  if (failedRequired.length > 0) {
    move("VERIFICATION_FAILED", { failed_checks: failedRequired.map((check) => check.id) });
    return finish();
  }
  verifiedSubject = {
    base_sha: baseSha,
    patch_digest: evidence.digest,
    changed_files: verification.changed_files,
  };
  move("VERIFICATION_PASSED");

  if (typeof runner.afterVerification === "function") {
    await runner.afterVerification({ cwd: repoDir, task, verifiedSubject });
  }
  const currentEvidence = await patchEvidence(repoDir, baseSha);
  if (currentEvidence.digest !== verifiedSubject.patch_digest) {
    gate("evidence_freshness", false, ["patch changed after verification"], {
      verified_patch_digest: verifiedSubject.patch_digest,
      current_patch_digest: currentEvidence.digest,
    });
    move("EVIDENCE_INVALIDATED", { current_patch_digest: currentEvidence.digest });
    return finish();
  }
  gate("evidence_freshness", true, [], { patch_digest: currentEvidence.digest });

  move("START_REVIEW");
  let reviewerResult;
  try {
    reviewerResult = await (reviewer ?? runner).run("reviewer", {
      cwd: repoDir,
      artifactsDir: agentsDir,
      input: {
        task,
        approved_plan: plannerResult.output,
        implementation: implementerResult.output,
        verification,
        diff: evidence.patch,
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gate("reviewer_runtime", false, [reason]);
    const reviewedEvidence = await patchEvidence(repoDir, baseSha);
    if (reviewedEvidence.digest !== verifiedSubject.patch_digest) {
      gate("evidence_freshness_after_review", false, ["patch changed during failed review"], {
        verified_patch_digest: verifiedSubject.patch_digest,
        current_patch_digest: reviewedEvidence.digest,
      });
      move("EVIDENCE_INVALIDATED", {
        current_patch_digest: reviewedEvidence.digest,
        reviewer_error: reason,
      });
      return finish();
    }
    gate("evidence_freshness_after_review", true, [], {
      patch_digest: reviewedEvidence.digest,
    });
    move("AGENT_FAILED", { role: "reviewer", reason });
    return finish();
  }
  agentEvidence.reviewer = reviewerResult.evidence;
  await writeJson(path.join(artifactsDir, "review.json"), reviewerResult.output);
  await writeJson(path.join(agentsDir, "reviewer.json"), reviewerResult.evidence);
  const reviewedEvidence = await patchEvidence(repoDir, baseSha);
  if (reviewedEvidence.digest !== verifiedSubject.patch_digest) {
    gate("evidence_freshness_after_review", false, ["patch changed during review"], {
      verified_patch_digest: verifiedSubject.patch_digest,
      current_patch_digest: reviewedEvidence.digest,
    });
    move("EVIDENCE_INVALIDATED", { current_patch_digest: reviewedEvidence.digest });
    return finish();
  }
  gate("evidence_freshness_after_review", true, [], {
    patch_digest: reviewedEvidence.digest,
  });
  const reviewContract = validateReview(reviewerResult.output, task);
  if (!reviewContract.ok) {
    gate("review", false, reviewContract.errors, { artifact: "artifacts/review.json" });
    move("REVIEW_REJECTED", { reasons: reviewContract.errors });
    return finish();
  }
  const semanticGate = reviewGate(reviewerResult.output);
  gate("review", semanticGate.passed, semanticGate.reasons, {
    artifact: "artifacts/review.json",
    mutation_tools_available: false,
    decision: reviewerResult.output.decision,
  });
  if (!semanticGate.passed) {
    if (reviewerResult.output.decision === "request_changes") {
      move("REVIEW_CHANGES_REQUESTED", { reasons: semanticGate.reasons });
    } else {
      move("REVIEW_REJECTED", { reasons: semanticGate.reasons });
    }
    return finish();
  }

  move("REVIEW_APPROVED");
  return finish();
}
