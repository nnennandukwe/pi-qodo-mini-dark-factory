# Review Retry Transaction Proof

## Scope

- Canonical state: the immutable original run receipt plus its verified repository worktree.
- Owned state: one unique `artifacts/review-attempts/<attempt-id>/` directory per retry.
- Coupled artifacts: Qodo context, progress, raw result, normalized review, reviewer evidence, and retry receipt.
- Readers: the CLI, evidence capture, and a human inspector.
- Concurrent actors: local editors, agents, and another retry process.

## State and commit point

| Start | Event | Result |
| --- | --- | --- |
| `REVIEWER_FAILED` | current patch digest differs | `EVIDENCE_STALE` |
| `REVIEWER_FAILED` | retry begins | `REVIEWING` |
| `REVIEWING` | reviewer runtime fails | `REVIEWER_FAILED` |
| `REVIEWING` | reviewer changes the patch | `EVIDENCE_STALE` |
| `REVIEWING` | invalid review contract | `REVIEW_REJECTED` |
| `REVIEWING` | blocking finding | `CHANGES_REQUESTED` |
| `REVIEWING` | sufficient approval, unchanged patch | `COMPLETE` |

The exact commit operation is renaming a fully written temporary receipt to
`receipt.json` inside the unique attempt directory. Readers treat an attempt as
committed only when that receipt exists. Earlier artifacts are staged evidence,
not a completed attempt.

A pre-commit failure preserves the original receipt and may leave one uniquely
named, receipt-less attempt directory for diagnosis. Retrying creates a new
attempt; it never overwrites the original or the incomplete attempt. There is no
post-commit cleanup. This prototype does not claim power-loss durability because
it does not fsync the file and directory.

The two digest reads detect a patch that remains changed. They cannot detect an
ABA race where an external writer changes the patch after Qodo gathers it and
restores the original bytes before the second digest read. Retry worktrees must
therefore remain controller-owned and isolated. Qodo would need to return the
reviewed patch digest before this prototype could prove that stronger guarantee.

## Invariants

| ID | Invariant | Enforcement | Evidence |
| --- | --- | --- | --- |
| RR-01 | A review retry starts only from `REVIEWER_FAILED` with a verified subject. | Retry coordinator input guard | Blocked-source test |
| RR-02 | The original receipt is never overwritten. | All writes target a unique attempt directory | Original-byte comparison |
| RR-03 | Qodo runs only if the current base and patch digest equal the verified subject. | Pre-review digest gate | Stale-before test |
| RR-04 | `COMPLETE` is possible only after a valid approving review and a second matching digest check. | Review and post-review gates | Happy and mutation tests |
| RR-05 | A reviewer runtime failure never becomes approval, including when it mutates the patch first. | Post-failure digest gate, then `AGENT_FAILED` or `EVIDENCE_INVALIDATED` | Reviewer-failure tests |
| RR-06 | Qodo findings never trigger edits in the retry command. | Reviewer interface is read-only; no remediation call exists | Changed-file assertion |
| RR-07 | Exactly one committed receipt describes each attempt. | Unique attempt ID plus atomic receipt rename | Commit-failure test |

## Fault-injection matrix

| Phase | Operation or event | Expected durable state | Recovery | Test |
| --- | --- | --- | --- | --- |
| Observe | Missing or malformed source receipt/artifact | Original files unchanged; no approval | Repair or select a valid run | Input-guard tests |
| Authorize | Source status is not `REVIEWER_FAILED` | No reviewer call | Select a failed-review run | Blocked-source test |
| Authorize | Patch changed before retry | Committed `EVIDENCE_STALE` attempt | Reimplement and rerun verification | Stale-before test |
| Review | Qodo process/auth/clone failure | Committed `REVIEWER_FAILED` attempt with reason | Fix stated Qodo condition and retry | Reviewer-failure test |
| Review | Reviewer mutates, then fails | Committed `EVIDENCE_STALE` attempt with both facts | Discard mutation and reverify | Mutation-plus-failure test |
| Review | Reviewer mutates repository | Committed `EVIDENCE_STALE` attempt | Discard mutation and reverify | Mutation-during-review test |
| Decide | Invalid review payload | Committed `REVIEW_REJECTED` attempt | Fix reviewer adapter | Invalid-contract test |
| Decide | High/critical finding | Committed `CHANGES_REQUESTED` attempt | User selects remediation, then reverify | Blocking-finding test |
| Commit | Receipt writer or rename fails | Original receipt intact; no committed retry receipt | Inspect partial attempt and retry | Commit-failure test |
| Concurrency | Patch changes between the two digest reads | Never `COMPLETE`; becomes `EVIDENCE_STALE` | Reverify changed patch | Mutation-during-review test |
| Concurrency | Patch changes and is restored between digest reads | Unsupported; isolation is required | Discard the attempt if concurrent access is suspected | Documented residual risk |

## Lifecycle closure

The test suite covers retry approval, blocked and malformed source state, stale
evidence before review, stored-diff tampering, reviewer runtime failure, path
containment for explicit attempt IDs, invalid
review contracts, blocking findings, mutation during review, duplicate attempts,
and receipt commit failure. A real Qodo retry remains the production-consumer
check; it cannot pass until the workspace clone-access incident clears.
