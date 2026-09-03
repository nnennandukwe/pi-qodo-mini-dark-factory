const TRANSITIONS = Object.freeze({
  READY: { START_PLANNING: "PLANNING" },
  PLANNING: {
    PLAN_ACCEPTED: "PLAN_APPROVED",
    PLAN_REJECTED: "PLAN_REJECTED",
    AGENT_FAILED: "PLANNER_FAILED",
  },
  PLAN_APPROVED: { START_IMPLEMENTATION: "IMPLEMENTING" },
  IMPLEMENTING: {
    IMPLEMENTATION_ACCEPTED: "IMPLEMENTED",
    IMPLEMENTATION_REJECTED: "IMPLEMENTATION_REJECTED",
    AGENT_FAILED: "IMPLEMENTER_FAILED",
  },
  IMPLEMENTED: { START_VERIFICATION: "VERIFYING" },
  VERIFYING: {
    VERIFICATION_PASSED: "VERIFIED",
    VERIFICATION_FAILED: "VERIFICATION_FAILED",
  },
  VERIFIED: {
    START_REVIEW: "REVIEWING",
    EVIDENCE_INVALIDATED: "EVIDENCE_STALE",
  },
  REVIEWING: {
    REVIEW_APPROVED: "COMPLETE",
    REVIEW_CHANGES_REQUESTED: "CHANGES_REQUESTED",
    REVIEW_REJECTED: "REVIEW_REJECTED",
    EVIDENCE_INVALIDATED: "EVIDENCE_STALE",
    AGENT_FAILED: "REVIEWER_FAILED",
  },
  REVIEWER_FAILED: {
    RETRY_REVIEW: "REVIEWING",
    EVIDENCE_INVALIDATED: "EVIDENCE_STALE",
  },
});

export const TERMINAL_STATES = new Set([
  "PLAN_REJECTED",
  "PLANNER_FAILED",
  "IMPLEMENTATION_REJECTED",
  "IMPLEMENTER_FAILED",
  "VERIFICATION_FAILED",
  "EVIDENCE_STALE",
  "CHANGES_REQUESTED",
  "REVIEW_REJECTED",
  "REVIEWER_FAILED",
  "COMPLETE",
]);

export function createRunState({ runId, taskId, startedAt }) {
  return Object.freeze({
    runId,
    taskId,
    status: "READY",
    startedAt,
    updatedAt: startedAt,
    history: [],
  });
}

export function transition(state, event, details = {}, at = new Date().toISOString()) {
  const nextStatus = TRANSITIONS[state.status]?.[event];
  if (!nextStatus) {
    throw new Error(`Illegal transition: ${state.status} --${event}--> ?`);
  }

  const historyEntry = Object.freeze({
    sequence: state.history.length + 1,
    from: state.status,
    event,
    to: nextStatus,
    at,
    details,
  });

  return Object.freeze({
    ...state,
    status: nextStatus,
    updatedAt: at,
    history: Object.freeze([...state.history, historyEntry]),
  });
}

export function isTerminal(state) {
  return TERMINAL_STATES.has(state.status);
}
