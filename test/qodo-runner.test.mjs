import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeQodoReview, QodoReviewer } from "../src/qodo-runner.mjs";
import { runPilot } from "../src/controller.mjs";
import { retryReview } from "../src/review-retry.mjs";
import { ScriptedRunner } from "../src/scripted-runner.mjs";
import { cliWorkspace, executable } from "./helpers/workspace.mjs";

const task = { id: "capture-state" };

test("Qodo action-required finding requests changes", () => {
  const review = normalizeQodoReview(
    {
      findings: [
        {
          title: "Idempotency replay regressed",
          action_level: "action_required",
          category: "correctness",
          diff_reference: { file_path: "src/app.py" },
        },
      ],
      meta: { reviewers: { ran: ["correctness"], skipped: [] } },
    },
    task,
  );
  assert.equal(review.decision, "request_changes");
  assert.equal(review.findings[0].severity, "high");
  assert.equal(review.findings[0].file, "src/app.py");
});

test("Qodo recommendations remain visible without blocking approval", () => {
  const review = normalizeQodoReview(
    {
      findings: [
        {
          finding_title: "Name could be clearer",
          severity_level: "remediation_recommended",
          file_path: "src/app.py",
        },
      ],
    },
    task,
  );
  assert.equal(review.decision, "approve");
  assert.equal(review.findings[0].severity, "medium");
});

test("Qodo incremental and reused results retain open blockers and deduplicate IDs", () => {
  const blocker = { id: "blocker", title: "Open blocker", action_level: "action_required" };
  const recommendation = { id: "recommendation", title: "Naming", action_level: "remediation_recommended" };
  for (const mode of ["incremental", "reused"]) {
    const review = normalizeQodoReview({
      findings: [recommendation],
      finding_state: {
        complete: true,
        introduced: [recommendation],
        still_open: [blocker],
        resolved: [{ id: "resolved", title: "Resolved blocker", action_level: "action_required" }],
        dismissed: [{ id: "dismissed", title: "Dismissed blocker", action_level: "action_required" }],
      },
      meta: { analysis: { mode }, coverage: { complete: true } },
    }, task);
    assert.equal(review.decision, "request_changes");
    assert.equal(review.findings.length, 2);
    assert.deepEqual(review.findings.map((finding) => finding.summary), ["Naming", "Open blocker"]);
  }
});

test("Qodo incomplete coverage and finding state require another review", () => {
  for (const fields of [
    { meta: { coverage: { complete: false }, reviewers: { ran: ["issue"] } } },
    { finding_state: { complete: false } },
  ]) {
    assert.throws(() => normalizeQodoReview({ findings: [], ...fields }, task), /incomplete.*retry/i);
  }
});

test("duplicate finding IDs preserve the strongest severity in either order", () => {
  const lower = { id: "same", title: "Lower severity", action_level: "informational" };
  for (const higher of [
    { id: "same", title: "Blocking severity", action_level: "action_required" },
    { id: "same", title: "Blocking severity", severity: "critical" },
  ]) {
    for (const [current, retained] of [[lower, higher], [higher, lower]]) {
      const review = normalizeQodoReview({
        findings: [current], finding_state: { complete: true, still_open: [retained] },
      }, task);
      assert.equal(review.decision, "request_changes");
      assert.equal(review.findings.length, 1);
      assert.equal(review.findings[0].summary, "Blocking severity");
    }
  }
});

test("Qodo rejects malformed finding state instead of dropping evidence", () => {
  for (const name of ["introduced", "still_open"]) {
    assert.throws(() => normalizeQodoReview({
      findings: [], finding_state: { complete: true, [name]: {} },
    }, task), /finding_state.*array/i);
  }
  for (const entry of ["blocker", 1, false, null, [], {}]) {
    for (const name of ["introduced", "still_open"]) {
      assert.throws(() => normalizeQodoReview({
        findings: [], finding_state: { complete: true, [name]: [entry] },
      }, task), /finding.*invalid.*retry/i);
    }
  }
});

test("incomplete and malformed Qodo results preserve evidence and recover through review retry", async (t) => {
  const workspace = await cliWorkspace(t);
  const resultPath = path.join(workspace.cwd, "review-result.json");
  const binary = await executable(workspace.cwd, "qodo-fixture", `
import { readFile } from "node:fs/promises";
process.stdout.write(await readFile(${JSON.stringify(resultPath)}, "utf8"));
`);
  const qodo = new QodoReviewer({ qodoBin: binary });
  qodo.readyRepository = "fixture/repo";
  const reviewer = { run: (role, context) => qodo.run(role, {
    ...context,
    input: { ...context.input, task: {
      ...context.input.task,
      repository: { repo_full_name: "fixture/repo", base_ref: "HEAD" },
    } },
  }) };
  for (const incomplete of [
    { findings: [], meta: { coverage: { complete: false }, reviewers: { ran: ["issue"] } } },
    { findings: [], finding_state: { complete: false } },
    { findings: [], finding_state: { complete: true, still_open: ["invalid finding"] } },
  ]) {
    const raw = `${JSON.stringify(incomplete)}\n`;
    await writeFile(resultPath, raw);
    const run = await runPilot({
      projectRoot: workspace.cwd,
      taskPath: path.join(workspace.cwd, "tasks/reject-expired-session-token.json"),
      runner: new ScriptedRunner(), runnerName: "scripted", reviewer, reviewerName: "qodo",
    });
    assert.equal(run.receipt.terminal_status, "REVIEWER_FAILED");
    assert.equal(run.receipt.success, false);
    assert.match(run.receipt.gates.find((gate) => gate.name === "reviewer_runtime").reasons.join(" "), /(?:incomplete|invalid).*retry/i);
    assert.ok(run.receipt.verified_subject.patch_digest);
    assert.equal(await readFile(path.join(run.artifactsDir, "agents/qodo-review-result.json"), "utf8"), raw);
    await assert.rejects(access(path.join(run.artifactsDir, "review.json")), { code: "ENOENT" });
    const receiptPath = path.join(run.artifactsDir, "receipt.json");
    const originalReceipt = await readFile(receiptPath, "utf8");

    const repeated = await retryReview({ runDir: run.runDir, reviewer, reportProgress: false });
    assert.equal(repeated.receipt.terminal_status, "REVIEWER_FAILED");
    assert.match(repeated.receipt.recovery, /retry/i);

    await writeFile(resultPath, JSON.stringify({
      findings: [{ id: "open", title: "Lower severity", action_level: "informational" }],
      finding_state: { complete: true, introduced: [], still_open: [
        { id: "open", title: "Retained blocker", action_level: "action_required" },
      ] },
      meta: { coverage: { complete: true }, analysis: { mode: "reused" } },
    }));
    const blocked = await retryReview({ runDir: run.runDir, reviewer, reportProgress: false });
    assert.equal(blocked.receipt.terminal_status, "CHANGES_REQUESTED");
    assert.equal(blocked.receipt.success, false);

    await writeFile(resultPath, JSON.stringify({ findings: [], meta: { coverage: { complete: true } } }));
    const recovered = await retryReview({ runDir: run.runDir, reviewer, reportProgress: false });
    assert.equal(recovered.receipt.terminal_status, "COMPLETE");
    assert.equal(recovered.receipt.verified_subject.patch_digest, run.receipt.verified_subject.patch_digest);
    assert.equal(await readFile(receiptPath, "utf8"), originalReceipt);
    assert.equal(await readFile(path.join(run.artifactsDir, "agents/qodo-review-result.json"), "utf8"), raw);
  }
});
