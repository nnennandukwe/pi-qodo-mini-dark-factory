import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeRepository, patchEvidence } from "../src/git.mjs";
import { retryReview } from "../src/review-retry.mjs";
import { createRunState, transition } from "../src/state-machine.mjs";

const NOW = "2026-09-03T00:00:00.000Z";

function reviewOutput({ decision = "approve", findings = [] } = {}) {
  return {
    task_id: "retry-task",
    decision,
    evidence_sufficient: true,
    findings,
    skipped_checks: [],
  };
}

class FakeReviewer {
  constructor({ output = reviewOutput(), error = null, mutate = false } = {}) {
    this.output = output;
    this.error = error;
    this.mutate = mutate;
    this.calls = 0;
  }

  async run(_role, { cwd }) {
    this.calls += 1;
    if (this.mutate) await writeFile(path.join(cwd, "code.txt"), "changed during review\n");
    if (this.error) throw this.error;
    return {
      output: this.output,
      evidence: {
        role: "reviewer",
        provider: "fake",
        usage: { input: 0, output: 0, cost_usd: 0, turns: 0 },
      },
    };
  }
}

function failedReviewState() {
  let state = createRunState({ runId: "source-run", taskId: "retry-task", startedAt: NOW });
  for (const event of [
    "START_PLANNING",
    "PLAN_ACCEPTED",
    "START_IMPLEMENTATION",
    "IMPLEMENTATION_ACCEPTED",
    "START_VERIFICATION",
    "VERIFICATION_PASSED",
    "START_REVIEW",
    "AGENT_FAILED",
  ]) {
    state = transition(state, event, {}, NOW);
  }
  return state;
}

async function sourceRun({ status = "REVIEWER_FAILED" } = {}) {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "pi-qodo-retry-"));
  const repoDir = path.join(runDir, "repo");
  const artifactsDir = path.join(runDir, "artifacts");
  await mkdir(repoDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(repoDir, "code.txt"), "baseline\n");
  const baseSha = await initializeRepository(repoDir);
  await writeFile(path.join(repoDir, "code.txt"), "verified change\n");
  const evidence = await patchEvidence(repoDir, baseSha);
  const task = {
    id: "retry-task",
    title: "Retry review",
    issue: "The prior reviewer was unavailable.",
    fixture: "unused",
    acceptance_criteria: ["Review the unchanged patch"],
    files_expected: ["code.txt"],
    files_allowed: ["code.txt"],
    required_test_files: ["code.txt"],
    constraints: ["Do not change code"],
    non_goals: ["Do not reimplement"],
    verification: [{ id: "held-out", argv: ["true"], required: true }],
  };
  const state = failedReviewState();
  const receipt = {
    schema_version: "mini-dark-factory-receipt/v2",
    run_id: "source-run",
    task_id: task.id,
    terminal_status: status,
    started_at: NOW,
    base_sha: baseSha,
    verified_subject: {
      base_sha: baseSha,
      patch_digest: evidence.digest,
      changed_files: ["code.txt"],
    },
    state_history: state.history,
  };
  await writeFile(path.join(artifactsDir, "task.json"), `${JSON.stringify(task)}\n`);
  await writeFile(
    path.join(artifactsDir, "plan.json"),
    `${JSON.stringify({
      task_id: task.id,
      summary: "Retry only the review",
      acceptance_criteria: task.acceptance_criteria,
      affected_files: task.files_expected,
      steps: ["Review the verified patch"],
      risks: ["External reviewer unavailable"],
      non_goals: task.non_goals,
    })}\n`,
  );
  await writeFile(
    path.join(artifactsDir, "implementation.json"),
    `${JSON.stringify({
      task_id: task.id,
      summary: "Verified change",
      changed_files: ["code.txt"],
      commands_run: ["true"],
      assumptions: [],
      unresolved_risks: [],
    })}\n`,
  );
  await writeFile(
    path.join(artifactsDir, "verification.json"),
    `${JSON.stringify({
      task_id: task.id,
      ...receipt.verified_subject,
      checks: [{ id: "held-out", required: true, exit_code: 0 }],
    })}\n`,
  );
  await writeFile(path.join(artifactsDir, "diff.patch"), evidence.patch);
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(path.join(artifactsDir, "receipt.json"), receiptText);
  return { runDir, repoDir, artifactsDir, receipt, receiptText };
}

test("retry approval commits a linked COMPLETE receipt without changing source receipt", async () => {
  const source = await sourceRun();
  const reviewer = new FakeReviewer();
  const result = await retryReview({
    runDir: source.runDir,
    reviewer,
    reviewerName: "fake",
    attemptId: "attempt-happy",
    reportProgress: false,
  });
  assert.equal(result.receipt.terminal_status, "COMPLETE");
  assert.equal(reviewer.calls, 1);
  assert.equal(await readFile(path.join(source.artifactsDir, "receipt.json"), "utf8"), source.receiptText);
  assert.equal(await readFile(path.join(source.repoDir, "code.txt"), "utf8"), "verified change\n");
});

test("retry rejects a source run that did not fail in review", async () => {
  const source = await sourceRun({ status: "COMPLETE" });
  const reviewer = new FakeReviewer();
  await assert.rejects(
    retryReview({
      runDir: source.runDir,
      reviewer,
      reviewerName: "fake",
      attemptId: "attempt-wrong-source",
      reportProgress: false,
    }),
    /Only REVIEWER_FAILED runs can retry review/,
  );
  assert.equal(reviewer.calls, 0);
});

test("retry blocks stale evidence before calling the reviewer", async () => {
  const source = await sourceRun();
  await writeFile(path.join(source.repoDir, "code.txt"), "edited after verification\n");
  const reviewer = new FakeReviewer();
  const result = await retryReview({
    runDir: source.runDir,
    reviewer,
    reviewerName: "fake",
    attemptId: "attempt-stale-before",
    reportProgress: false,
  });
  assert.equal(result.receipt.terminal_status, "EVIDENCE_STALE");
  assert.equal(reviewer.calls, 0);
  assert.match(result.receipt.recovery, /rerun implementation and verification/i);
});

test("reviewer runtime failure commits failure evidence and recovery guidance", async () => {
  const source = await sourceRun();
  const result = await retryReview({
    runDir: source.runDir,
    reviewer: new FakeReviewer({ error: new Error("clone access unavailable") }),
    reviewerName: "fake",
    attemptId: "attempt-runtime-failure",
    reportProgress: false,
  });
  assert.equal(result.receipt.terminal_status, "REVIEWER_FAILED");
  assert.match(result.receipt.recovery, /fix the reviewer error/i);
  const runtimeGate = result.receipt.gates.find((gate) => gate.name === "reviewer_runtime");
  assert.match(runtimeGate.reasons.join("\n"), /clone access unavailable/);
  assert.equal(result.receipt.gates.at(-1).name, "evidence_freshness_after_review");
  assert.equal(result.receipt.gates.at(-1).passed, true);
});

test("blocking review finding commits CHANGES_REQUESTED", async () => {
  const source = await sourceRun();
  const reviewer = new FakeReviewer({
    output: reviewOutput({
      decision: "request_changes",
      findings: [{ severity: "high", summary: "Incorrect boundary", file: "code.txt" }],
    }),
  });
  const result = await retryReview({
    runDir: source.runDir,
    reviewer,
    reviewerName: "fake",
    attemptId: "attempt-changes",
    reportProgress: false,
  });
  assert.equal(result.receipt.terminal_status, "CHANGES_REQUESTED");
});

test("mutation during review commits EVIDENCE_STALE instead of approval", async () => {
  const source = await sourceRun();
  const result = await retryReview({
    runDir: source.runDir,
    reviewer: new FakeReviewer({ mutate: true }),
    reviewerName: "fake",
    attemptId: "attempt-mutation",
    reportProgress: false,
  });
  assert.equal(result.receipt.terminal_status, "EVIDENCE_STALE");
});

test("mutation followed by reviewer failure still commits EVIDENCE_STALE", async () => {
  const source = await sourceRun();
  const result = await retryReview({
    runDir: source.runDir,
    reviewer: new FakeReviewer({ mutate: true, error: new Error("review failed after mutation") }),
    reviewerName: "fake",
    attemptId: "attempt-mutation-and-failure",
    reportProgress: false,
  });
  assert.equal(result.receipt.terminal_status, "EVIDENCE_STALE");
  const runtimeGate = result.receipt.gates.find((gate) => gate.name === "reviewer_runtime");
  const freshnessGate = result.receipt.gates.find(
    (gate) => gate.name === "evidence_freshness_after_review",
  );
  assert.match(runtimeGate.reasons.join("\n"), /review failed after mutation/);
  assert.match(freshnessGate.reasons.join("\n"), /changed during failed review/);
});

test("receipt commit failure leaves no committed attempt and preserves source", async () => {
  const source = await sourceRun();
  await assert.rejects(
    retryReview({
      runDir: source.runDir,
      reviewer: new FakeReviewer(),
      reviewerName: "fake",
      attemptId: "attempt-commit-failure",
      reportProgress: false,
      commitReceipt: async () => {
        throw new Error("injected receipt rename failure");
      },
    }),
    /injected receipt rename failure/,
  );
  await assert.rejects(
    access(
      path.join(
        source.artifactsDir,
        "review-attempts",
        "attempt-commit-failure",
        "receipt.json",
      ),
    ),
  );
  assert.equal(await readFile(path.join(source.artifactsDir, "receipt.json"), "utf8"), source.receiptText);
});

test("tampered stored diff is rejected before the reviewer runs", async () => {
  const source = await sourceRun();
  await writeFile(path.join(source.artifactsDir, "diff.patch"), "tampered diff\n");
  const reviewer = new FakeReviewer();
  await assert.rejects(
    retryReview({
      runDir: source.runDir,
      reviewer,
      reviewerName: "fake",
      attemptId: "attempt-tampered-diff",
      reportProgress: false,
    }),
    /Stored diff artifact does not match the current verified Git patch/,
  );
  assert.equal(reviewer.calls, 0);
});

test("invalid reviewer contract commits REVIEW_REJECTED", async () => {
  const source = await sourceRun();
  const result = await retryReview({
    runDir: source.runDir,
    reviewer: new FakeReviewer({ output: { task_id: "retry-task", decision: "approve" } }),
    reviewerName: "fake",
    attemptId: "attempt-invalid-review",
    reportProgress: false,
  });
  assert.equal(result.receipt.terminal_status, "REVIEW_REJECTED");
  assert.match(result.receipt.gates.at(-1).reasons.join("\n"), /evidence_sufficient/);
});

test("malformed source receipt fails before creating review evidence", async () => {
  const source = await sourceRun();
  await writeFile(path.join(source.artifactsDir, "receipt.json"), "{not-json\n");
  const reviewer = new FakeReviewer();
  await assert.rejects(
    retryReview({
      runDir: source.runDir,
      reviewer,
      reviewerName: "fake",
      attemptId: "attempt-malformed-source",
      reportProgress: false,
    }),
    /Invalid source receipt/,
  );
  assert.equal(reviewer.calls, 0);
});

test("duplicate attempt id returns actionable recovery text", async () => {
  const source = await sourceRun();
  const attemptDir = path.join(source.artifactsDir, "review-attempts", "duplicate-attempt");
  await mkdir(attemptDir, { recursive: true });
  const reviewer = new FakeReviewer();
  await assert.rejects(
    retryReview({
      runDir: source.runDir,
      reviewer,
      reviewerName: "fake",
      attemptId: "duplicate-attempt",
      reportProgress: false,
    }),
    /already exists.*omit --attempt-id or choose a new value/i,
  );
  assert.equal(reviewer.calls, 0);
});

test("attempt id cannot escape the review-attempts directory", async () => {
  const source = await sourceRun();
  const reviewer = new FakeReviewer();
  await assert.rejects(
    retryReview({
      runDir: source.runDir,
      reviewer,
      reviewerName: "fake",
      attemptId: "..",
      reportProgress: false,
    }),
    /attemptId must be a safe path segment/,
  );
  assert.equal(reviewer.calls, 0);
});

test("failed stored verification evidence is rejected before review", async () => {
  const source = await sourceRun();
  const verificationPath = path.join(source.artifactsDir, "verification.json");
  const verification = JSON.parse(await readFile(verificationPath, "utf8"));
  verification.checks[0].exit_code = 1;
  await writeFile(verificationPath, `${JSON.stringify(verification)}\n`);
  const reviewer = new FakeReviewer();
  await assert.rejects(
    retryReview({
      runDir: source.runDir,
      reviewer,
      reviewerName: "fake",
      attemptId: "attempt-failed-verification",
      reportProgress: false,
    }),
    /Required verification evidence is not passing/,
  );
  assert.equal(reviewer.calls, 0);
});
