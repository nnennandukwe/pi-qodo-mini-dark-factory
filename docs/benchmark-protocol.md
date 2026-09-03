# Five-task benchmark protocol

## Question

Does the planner → implementer → deterministic verifier → Qodo reviewer workflow improve completion, reviewability, or defect capture enough to justify its extra time and model cost on small bounded tasks?

This compares two systems, not only two prompting styles:

- **Baseline:** one Pi coding agent, followed by the same controller-owned deterministic checks.
- **Factory:** a read-only Pi planner, a separate Pi implementer, the deterministic checks, and Qodo local review of the verified patch.

Both conditions use the same provider, model, reasoning level, task manifest, public base revision, and required commands. Pi starts without session history for every role. The benchmark policy accepts only the five named tasks, the exact HTTPS fixture URL with `main`/`origin/main`, pinned `nnennandukwe/pi-qodo-quality-fixture` revision, their assigned held-out oracles, and the exact `node`/`npm` verification command set.

This protocol measures the bounded quality loop; it does not represent the full Qodo Agentic Toolbox. Pi skill discovery is disabled for both conditions, Qodo Codebase Wisdom and Qodo Rules are not injected into planning or implementation, and Qodo Review Resolver requires a separate PR-based walkthrough. Keeping those capabilities outside this comparison preserves a stable treatment boundary and prevents an administrative or post-PR workflow from being counted as implementation quality.

## Task set and order

| Order | Category | Task | First condition |
| --- | --- | --- | --- |
| 1 | Reproducible bug | Reject expired session tokens | Baseline |
| 2 | Validation rule | Validate the TCP service-port range | Factory |
| 3 | Edge-case tests | Cover tag parser duplicates and empty segments | Baseline |
| 4 | Behavior-preserving refactor | Deduplicate email canonicalization | Factory |
| 5 | Security/correctness | Block sibling-prefix download path escapes | Baseline |

Each task runs once under each condition. Alternating the first condition reduces a simple order bias; it does not make five tasks statistically representative.

## Measures

The summary records, per condition:

- task completion and required-check pass rates;
- verifier catches, defined as an accepted implementation handoff followed by a failed required check;
- changed files outside the task's expected set;
- wall time, time from run start to the first passing deterministic verification, and verification-command duration;
- Pi input/output tokens, turns, and reported model cost;
- Qodo decision, findings, skipped checks, and review duration for the factory condition.

Human-review time and substantive human corrections are explicitly `null` because no human review session is embedded in an automated run. Qodo cost is also unavailable from the CLI result.

## Durable checkpoint and recovery contract

The canonical benchmark state is the set of condition records under `.factory-runs/benchmarks/<benchmark-id>/results/`. `metadata.json` binds the suite digest, every task-manifest digest, runtime configuration, and committed harness revision. `summary.json` is a rebuildable projection of committed records.

The commit point for each JSON artifact is `rename(unique-temporary-file, canonical-path)`. Before that rename, failure leaves the previous canonical file unchanged. There is no post-commit cleanup step: the rename consumes the owned temporary file.

Invariants:

- A condition is complete only if its schema-valid record exists at its deterministic order/task/condition path.
- Resume skips only committed records whose order, task, condition, and manifest digest match.
- Every condition uses the policy-pinned fixture SHA `2f37e9f3e1a5cb6d22e9f95e3c6c99e1772afa8f`; a changed remote branch is rejected before an agent or verification command runs.
- Verification commands are limited to the assigned held-out oracle plus the exact tests, lint, format, typecheck, and security commands.
- Changed suite data, task manifests, runtime configuration, or harness revision reject resume.
- A failed write or rename never replaces the previous canonical checkpoint.
- Only the uniquely named temporary checkpoint is eligible for failure cleanup.
- Checkpoint and result directories must be real directories directly beneath the harness-owned benchmark root; symlinked directories are rejected before reads or writes.
- Raw Pi and Qodo event streams remain inside Git-ignored run directories.

Failure evidence covers a staging failure, commit-time rename failure, symlinked checkpoint directory, and interrupted external condition followed by resume. Malformed checkpoints, mismatched configuration, and non-policy fixture revisions fail closed. A hostile process running as the same local user could still race directory validation and mutation; use an isolated VM or container when that actor is in scope.

## Run and resume

Start from a clean, committed harness worktree after authenticating Pi and Qodo:

```bash
npm run benchmark -- \
  --provider openai-codex \
  --model gpt-5.5 \
  --qodo-depth fast
```

If an external call interrupts the sequence, use the exact directory printed in the error:

```bash
npm run benchmark -- \
  --provider openai-codex \
  --model gpt-5.5 \
  --qodo-depth fast \
  --resume .factory-runs/benchmarks/<benchmark-id>
```

Resume requires the same suite and runtime configuration. It never reruns a committed condition.
