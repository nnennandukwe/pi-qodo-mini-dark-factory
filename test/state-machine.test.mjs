import assert from "node:assert/strict";
import test from "node:test";

import { createRunState, transition } from "../src/state-machine.mjs";

test("happy path reaches COMPLETE only through every gate", () => {
  let state = createRunState({
    runId: "run-1",
    taskId: "task-1",
    startedAt: "2026-09-02T00:00:00.000Z",
  });
  for (const event of [
    "START_PLANNING",
    "PLAN_ACCEPTED",
    "START_IMPLEMENTATION",
    "IMPLEMENTATION_ACCEPTED",
    "START_VERIFICATION",
    "VERIFICATION_PASSED",
    "START_REVIEW",
    "REVIEW_APPROVED",
  ]) {
    state = transition(state, event, {}, "2026-09-02T00:00:01.000Z");
  }
  assert.equal(state.status, "COMPLETE");
  assert.equal(state.history.length, 8);
});

test("illegal transitions fail closed", () => {
  const state = createRunState({
    runId: "run-1",
    taskId: "task-1",
    startedAt: "2026-09-02T00:00:00.000Z",
  });
  assert.throws(() => transition(state, "REVIEW_APPROVED"), /Illegal transition/);
});

test("post-verification mutation becomes EVIDENCE_STALE", () => {
  let state = createRunState({
    runId: "run-1",
    taskId: "task-1",
    startedAt: "2026-09-02T00:00:00.000Z",
  });
  for (const event of [
    "START_PLANNING",
    "PLAN_ACCEPTED",
    "START_IMPLEMENTATION",
    "IMPLEMENTATION_ACCEPTED",
    "START_VERIFICATION",
    "VERIFICATION_PASSED",
    "EVIDENCE_INVALIDATED",
  ]) {
    state = transition(state, event);
  }
  assert.equal(state.status, "EVIDENCE_STALE");
});

test("a failed reviewer can retry without rerunning implementation", () => {
  let state = createRunState({
    runId: "run-1",
    taskId: "task-1",
    startedAt: "2026-09-02T00:00:00.000Z",
  });
  for (const event of [
    "START_PLANNING",
    "PLAN_ACCEPTED",
    "START_IMPLEMENTATION",
    "IMPLEMENTATION_ACCEPTED",
    "START_VERIFICATION",
    "VERIFICATION_PASSED",
    "START_REVIEW",
    "AGENT_FAILED",
    "RETRY_REVIEW",
    "REVIEW_APPROVED",
  ]) {
    state = transition(state, event);
  }
  assert.equal(state.status, "COMPLETE");
});

test("a mutation during review invalidates verified evidence", () => {
  let state = createRunState({
    runId: "run-1",
    taskId: "task-1",
    startedAt: "2026-09-02T00:00:00.000Z",
  });
  for (const event of [
    "START_PLANNING",
    "PLAN_ACCEPTED",
    "START_IMPLEMENTATION",
    "IMPLEMENTATION_ACCEPTED",
    "START_VERIFICATION",
    "VERIFICATION_PASSED",
    "START_REVIEW",
    "EVIDENCE_INVALIDATED",
  ]) {
    state = transition(state, event);
  }
  assert.equal(state.status, "EVIDENCE_STALE");
});
