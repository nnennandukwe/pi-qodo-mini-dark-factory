import assert from "node:assert/strict";
import test from "node:test";

import { normalizeQodoReview } from "../src/qodo-runner.mjs";

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
