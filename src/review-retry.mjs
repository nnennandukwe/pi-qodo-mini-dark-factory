import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  reviewGate,
  validateImplementationReport,
  validatePlan,
  validateReview,
  validateTask,
} from "./contracts.mjs";
import { changedFiles, patchEvidence } from "./git.mjs";
import { transition } from "./state-machine.mjs";

function safeTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((item) => right.includes(item));
}

async function readJson(file, label) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${file}: ${error.message}`);
  }
  try {
    return { value: JSON.parse(text), text };
  } catch (error) {
    throw new Error(`Invalid ${label} at ${file}: ${error.message}`);
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function atomicWriteJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

function restoreState(receipt) {
  const lastStatus = receipt.state_history?.at(-1)?.to;
  if (lastStatus !== receipt.terminal_status) {
    throw new Error(
      `Source receipt state mismatch: history ends at ${lastStatus ?? "nothing"}, ` +
        `but terminal_status is ${receipt.terminal_status}. Select an intact run receipt.`,
    );
  }
  return Object.freeze({
    runId: receipt.run_id,
    taskId: receipt.task_id,
    status: receipt.terminal_status,
    startedAt: receipt.started_at,
    updatedAt: receipt.finished_at ?? receipt.started_at,
    history: Object.freeze(receipt.state_history.map((entry) => Object.freeze(entry))),
  });
}

async function artifactPaths(attemptDir) {
  const candidates = {
    context: "qodo-context.json",
    qodo_result: "qodo-review-result.json",
    qodo_progress: "qodo-review-progress.ndjson",
    review: "review.json",
    reviewer: "reviewer.json",
  };
  const present = {};
  for (const [name, relative] of Object.entries(candidates)) {
    try {
      await access(path.join(attemptDir, relative));
      present[name] = relative;
    } catch {
      // Staged artifacts are optional until the receipt commits the attempt.
    }
  }
  return present;
}

function renderState(state, latestGate) {
  process.stderr.write(
    `\n=== REVIEW RETRY STATE ===\n${JSON.stringify(
      {
        run_id: state.runId,
        task_id: state.taskId,
        status: state.status,
        latest_gate: latestGate ?? null,
        transition_count: state.history.length,
      },
      null,
      2,
    )}\n`,
  );
}

export async function retryReview({
  runDir,
  reviewer,
  reviewerName,
  attemptId = `${safeTimestamp()}-${randomUUID().slice(0, 8)}`,
  commitReceipt = atomicWriteJson,
  reportProgress = true,
}) {
  if (!/^[a-zA-Z0-9._-]+$/.test(attemptId) || [".", ".."].includes(attemptId)) {
    throw new Error(
      "attemptId must be a safe path segment using only letters, numbers, dot, underscore, and hyphen",
    );
  }
  const artifactsDir = path.join(runDir, "artifacts");
  const repoDir = path.join(runDir, "repo");
  const sourceReceiptPath = path.join(artifactsDir, "receipt.json");
  const sourceReceiptFile = await readJson(sourceReceiptPath, "source receipt");
  const sourceReceipt = sourceReceiptFile.value;
  if (sourceReceipt.terminal_status !== "REVIEWER_FAILED") {
    throw new Error(
      `Only REVIEWER_FAILED runs can retry review; source is ${sourceReceipt.terminal_status}. ` +
        "Select the failed-review run or start a new fully verified run.",
    );
  }
  if (!sourceReceipt.verified_subject?.patch_digest || !sourceReceipt.base_sha) {
    throw new Error(
      "Source run has no verified subject. Rerun implementation and deterministic verification first.",
    );
  }
  if (sourceReceipt.verified_subject.base_sha !== sourceReceipt.base_sha) {
    throw new Error(
      "Source receipt base SHA does not match its verified subject. Select an intact run receipt.",
    );
  }

  let state = restoreState(sourceReceipt);
  const task = (await readJson(path.join(artifactsDir, "task.json"), "task artifact")).value;
  const taskContract = validateTask(task);
  if (!taskContract.ok) throw new Error(`Invalid task artifact: ${taskContract.errors.join("; ")}`);
  if (task.id !== sourceReceipt.task_id) {
    throw new Error("Task artifact does not belong to the source receipt");
  }
  const plan = (await readJson(path.join(artifactsDir, "plan.json"), "plan artifact")).value;
  const implementation = (
    await readJson(path.join(artifactsDir, "implementation.json"), "implementation artifact")
  ).value;
  const verification = (
    await readJson(path.join(artifactsDir, "verification.json"), "verification artifact")
  ).value;
  const diff = await readFile(path.join(artifactsDir, "diff.patch"), "utf8");
  if (
    verification.task_id !== task.id ||
    verification.patch_digest !== sourceReceipt.verified_subject.patch_digest ||
    verification.base_sha !== sourceReceipt.base_sha
  ) {
    throw new Error("Verification artifact does not match the source receipt's verified subject");
  }
  const actualChangedFiles = await changedFiles(repoDir, sourceReceipt.base_sha);
  const planContract = validatePlan(plan, task);
  if (!planContract.ok) {
    throw new Error(`Invalid plan artifact: ${planContract.errors.join("; ")}`);
  }
  const implementationContract = validateImplementationReport(
    implementation,
    task,
    actualChangedFiles,
  );
  if (!implementationContract.ok) {
    throw new Error(`Invalid implementation artifact: ${implementationContract.errors.join("; ")}`);
  }
  if (
    !Array.isArray(verification.changed_files) ||
    !sameMembers(verification.changed_files, actualChangedFiles) ||
    !sameMembers(sourceReceipt.verified_subject.changed_files ?? [], actualChangedFiles)
  ) {
    throw new Error("Changed-file evidence does not match the current Git worktree");
  }
  const requiredFailures = task.verification
    .filter((expected) => expected.required)
    .filter((expected) => {
      const recorded = verification.checks?.find((check) => check.id === expected.id);
      return !recorded || recorded.required !== true || recorded.exit_code !== 0;
    });
  if (requiredFailures.length > 0) {
    throw new Error(
      `Required verification evidence is not passing: ${requiredFailures
        .map((check) => check.id)
        .join(", ")}. Rerun deterministic verification before review.`,
    );
  }

  const startedAt = new Date().toISOString();
  const attemptsDir = path.join(artifactsDir, "review-attempts");
  const attemptDir = path.join(attemptsDir, attemptId);
  await mkdir(attemptsDir, { recursive: true });
  try {
    await mkdir(attemptDir, { recursive: false });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `Review attempt ${attemptId} already exists; omit --attempt-id or choose a new value.`,
        { cause: error },
      );
    }
    throw error;
  }
  const gates = [];
  const gate = (name, passed, reasons, evidence = {}) => {
    const decision = { name, passed, reasons, evidence, at: new Date().toISOString() };
    gates.push(decision);
    return decision;
  };
  const finish = async (recovery) => {
    const receipt = {
      schema_version: "mini-dark-factory-review-retry/v1",
      attempt_id: attemptId,
      parent_run_id: sourceReceipt.run_id,
      source_receipt_sha256: createHash("sha256").update(sourceReceiptFile.text).digest("hex"),
      task_id: task.id,
      reviewer: reviewerName,
      terminal_status: state.status,
      success: state.status === "COMPLETE",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      verified_subject: sourceReceipt.verified_subject,
      state_history: state.history,
      gates,
      artifact_paths: await artifactPaths(attemptDir),
      recovery,
    };
    const receiptPath = path.join(attemptDir, "receipt.json");
    await commitReceipt(receiptPath, receipt);
    return { receipt, receiptPath, attemptDir, repoDir };
  };

  const before = await patchEvidence(repoDir, sourceReceipt.base_sha);
  if (before.digest !== sourceReceipt.verified_subject.patch_digest) {
    gate("evidence_freshness_before_review", false, ["patch changed after verification"], {
      verified_patch_digest: sourceReceipt.verified_subject.patch_digest,
      current_patch_digest: before.digest,
    });
    state = transition(state, "EVIDENCE_INVALIDATED", { current_patch_digest: before.digest });
    if (reportProgress) renderState(state, gates.at(-1));
    return finish("Restore the verified patch or rerun implementation and verification before review.");
  }
  if (before.patch !== diff) {
    throw new Error(
      "Stored diff artifact does not match the current verified Git patch. " +
        "Preserve this run for diagnosis and start a new fully verified run.",
    );
  }
  gate("evidence_freshness_before_review", true, [], { patch_digest: before.digest });
  state = transition(state, "RETRY_REVIEW", { attempt_id: attemptId, reviewer: reviewerName });
  if (reportProgress) renderState(state, gates.at(-1));

  let reviewerResult;
  try {
    reviewerResult = await reviewer.run("reviewer", {
      cwd: repoDir,
      artifactsDir: attemptDir,
      input: { task, approved_plan: plan, implementation, verification, diff },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    gate("reviewer_runtime", false, [reason]);
    const afterFailure = await patchEvidence(repoDir, sourceReceipt.base_sha);
    if (afterFailure.digest !== sourceReceipt.verified_subject.patch_digest) {
      gate("evidence_freshness_after_review", false, ["patch changed during failed review"], {
        verified_patch_digest: sourceReceipt.verified_subject.patch_digest,
        current_patch_digest: afterFailure.digest,
      });
      state = transition(state, "EVIDENCE_INVALIDATED", {
        current_patch_digest: afterFailure.digest,
        reviewer_error: reason,
      });
      if (reportProgress) renderState(state, gates.at(-1));
      return finish("Discard the review-time mutation and rerun implementation and verification.");
    }
    gate("evidence_freshness_after_review", true, [], { patch_digest: afterFailure.digest });
    state = transition(state, "AGENT_FAILED", { role: "reviewer", reason });
    if (reportProgress) renderState(state, gates.at(-1));
    return finish("Fix the reviewer error shown in the gate evidence, then run retry-review again.");
  }

  await writeJson(path.join(attemptDir, "review.json"), reviewerResult.output);
  await writeJson(path.join(attemptDir, "reviewer.json"), reviewerResult.evidence);
  const after = await patchEvidence(repoDir, sourceReceipt.base_sha);
  if (after.digest !== sourceReceipt.verified_subject.patch_digest) {
    gate("evidence_freshness_after_review", false, ["patch changed during review"], {
      verified_patch_digest: sourceReceipt.verified_subject.patch_digest,
      current_patch_digest: after.digest,
    });
    state = transition(state, "EVIDENCE_INVALIDATED", { current_patch_digest: after.digest });
    if (reportProgress) renderState(state, gates.at(-1));
    return finish("Discard the review-time mutation and rerun implementation and verification.");
  }
  gate("evidence_freshness_after_review", true, [], { patch_digest: after.digest });

  const reviewContract = validateReview(reviewerResult.output, task);
  if (!reviewContract.ok) {
    gate("review", false, reviewContract.errors, { artifact: "review.json" });
    state = transition(state, "REVIEW_REJECTED", { reasons: reviewContract.errors });
    if (reportProgress) renderState(state, gates.at(-1));
    return finish("Fix the reviewer adapter contract, then run retry-review again.");
  }
  const semanticGate = reviewGate(reviewerResult.output);
  gate("review", semanticGate.passed, semanticGate.reasons, {
    artifact: "review.json",
    mutation_tools_available: false,
    decision: reviewerResult.output.decision,
  });
  if (!semanticGate.passed) {
    if (reviewerResult.output.decision === "request_changes") {
      state = transition(state, "REVIEW_CHANGES_REQUESTED", { reasons: semanticGate.reasons });
      if (reportProgress) renderState(state, gates.at(-1));
      return finish("Evaluate the findings, apply only approved fixes, and rerun verification.");
    }
    state = transition(state, "REVIEW_REJECTED", { reasons: semanticGate.reasons });
    if (reportProgress) renderState(state, gates.at(-1));
    return finish("Resolve the insufficient review evidence, then run retry-review again.");
  }

  state = transition(state, "REVIEW_APPROVED", { attempt_id: attemptId });
  if (reportProgress) renderState(state, gates.at(-1));
  return finish(null);
}
