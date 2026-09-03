# Pi x Qodo Mini Dark Factory

> **Pilot harness — inspectable engineering workflow, not production automation.**

This repository tests one narrow question: does explicit role separation make an agentic code change easier to inspect without allowing agent confidence to replace executable evidence?

The controller separates planning, implementation, deterministic verification, and semantic review. Only the controller advances the workflow. The public Qodo path has completed one live end-to-end run against [`nnennandukwe/pi-qodo-quality-fixture`](https://github.com/nnennandukwe/pi-qodo-quality-fixture); that proves the integration path works, not that the workflow improves quality across tasks.

## Architecture

| Stage | Runtime | Authority |
| --- | --- | --- |
| Planner | Pi, read-only tools | Proposes exact criteria, files, risks, and non-goals |
| Implementer | Pi, editing tools | Produces a minimal diff and structured handoff |
| Verifier | Controller-owned commands | Runs held-out behavior, tests, lint, format, types, and security checks |
| Reviewer | Pi or Qodo | Supplies semantic findings and an approve/request-changes decision |
| Controller | Local Node.js state machine | Validates contracts, binds evidence to a Git patch digest, and owns progression |

Qodo does not replace deterministic verification. A missing, failed, or unavailable Qodo result leaves the run in `REVIEWER_FAILED`; it never becomes an implicit approval.

## Run the local pilot

The required runtime is pinned in `.nvmrc`.

```bash
nvm install
nvm use
npm ci
npm test
npm run pilot:acceptance
```

Authenticate Pi, then run the live multi-agent task and one-agent baseline against the embedded fixture:

```bash
pi
# In Pi: /login openai-codex
pi auth check --provider openai-codex --json

npm run pilot:pi -- --provider openai-codex --model gpt-5.5
npm run pilot:baseline -- --provider openai-codex --model gpt-5.5
```

`pilot:acceptance` exercises the happy path and six blocked paths, including mutations after verification. A live run produces a receipt under `.factory-runs/<run-id>/`.

## Run Pi with Qodo review

Qodo requires a logged-in CLI and a base repository connected to the active Qodo workspace. The base commit stays available on GitHub; the implementation remains local and unpushed.

```bash
qodo read whoami \
  --json \
  --skill qodo-review \
  --skill-version 1.9.5 \
  --distribution qodo-cli-managed
npm run pilot:pi-qodo -- \
  --provider openai-codex \
  --model gpt-5.5 \
  --qodo-depth fast
```

The Qodo gate is complete only when Qodo returns structured findings, the controller records them, no high-severity finding remains, and the reviewed patch digest still matches the verified subject. A missing, failed, or unavailable Qodo result leaves the run in `REVIEWER_FAILED`; it never becomes an implicit approval.

If Pi and deterministic verification already passed, retry only the external review:

```bash
npm run review:retry -- \
  --run-dir .factory-runs/<reviewer-failed-run-id> \
  --qodo-depth fast
```

The retry command accepts only a `REVIEWER_FAILED` source receipt, rechecks the patch digest before and after review, never overwrites the original receipt, and commits a separate attempt receipt last. See `docs/review-retry-proof.md` for the state, invariant, and failure model.

## Qodo Agentic Toolbox coverage

This repository does not yet demonstrate the entire Qodo Agentic Toolbox. As of 2026-09-02 PDT, Qodo's public skills catalog separates a default `qodo` package from the optional `qodo-standards` package. The live CLI exposes 33 read-only managed tools and 16 approval-gated write tools underneath those workflows; a task should invoke only the tools relevant to its stage, not every catalog entry.

| Workflow | Package | Evidence in this repository |
| --- | --- | --- |
| Qodo Setup `1.0.5` | `qodo` | Setup was completed outside the harness; every Qodo run revalidates the authenticated principal. |
| Qodo Codebase Wisdom `1.1.2` | `qodo` | Partial only. Preflight resolves the public repository through Qodo, but Pi does not yet receive Qodo code, history, prior-PR, or cross-repository context. |
| Qodo Local Review `1.9.5` | `qodo` | Proven. Qodo reviewed the local verified patch and returned structured findings before any push or PR. |
| Qodo Review Resolver `1.4.3` | `qodo` | Not exercised. The public repositories have no PR, and the prototype does not push branches or update PR findings. |
| Qodo Rules `1.1.2` | `qodo-standards` | Access is proven, but retrieved rules are not yet inputs to the planner or implementer. |
| Qodo Standards Manager `1.0.2` | `qodo-standards` | Intentionally out of scope. It mutates organization standards and is not required to evaluate a code-change workflow. |

Pi is a supported portable-skills target, but the benchmark currently launches Pi with skill discovery disabled so each role receives only its explicit contract and tool allowlist. The current claim is therefore narrow: **Pi orchestrates the roles and Qodo independently reviews the verified local patch.** It is not yet evidence that Pi natively invoked every Qodo skill.

The [Qodo skills catalog](https://github.com/qodo-ai/qodo-skills) is the source of truth for package membership and current workflow versions. The quantitative benchmark below remains focused on role separation and the local-review gate. A separate launch walkthrough is needed to demonstrate native skill installation, Codebase Wisdom and Rules before implementation, and Review Resolver on a real PR without mixing those lifecycle demonstrations into the benchmark result.

## Latest proven run

On 2026-09-02 PDT (2026-09-03 UTC), the live Pi-to-Qodo path completed the task “reject expired API tokens during session renewal” from public fixture commit `b7ad2dfb64371fc4316e7570e4633fe532f804ec`.

- Pi `0.84.4` ran on Node.js `22.23.2` with `openai-codex`, `gpt-5.5`, and medium reasoning.
- The implementation changed only `src/session.ts` and `tests/session.test.ts`.
- The held-out behavior oracle, tests, lint, formatting, type checks, and security checks all passed.
- Qodo reviewed the verified patch at fast depth and returned `approve` with zero findings. Issue, compliance, skills, and specification review ran; the safety net ran and reinjected zero findings. UI, persona, and cross-repository review were not applicable to this single-repository backend task.
- The controller confirmed the patch digest before and after review: `e8e7301cc9da4c5a14c8d9c5e0509b88cb335e848db09c827b6d29f16f621aed`.
- End-to-end wall time was 107.5 seconds. Pi used 9,851 input tokens, 1,184 output tokens, eight turns, and reported $0.091943 in model cost. Qodo review took 61.8 seconds; its cost was not exposed.

The raw receipt and agent event streams remain local and Git-ignored. This README records the bounded result without publishing machine-specific or transcript-heavy artifacts.

## Run the five-task benchmark

The benchmark pairs the one-agent baseline with the Pi planner/implementer, deterministic verifier, and Qodo local-review workflow across the five planned task types. It alternates which condition runs first and requires a clean harness worktree so every result is bound to a committed controller revision. This is the quality-loop benchmark, not a claim that every Qodo toolbox workflow runs in every condition.

```bash
npm run benchmark -- \
  --provider openai-codex \
  --model gpt-5.5 \
  --qodo-depth fast
```

Every completed condition is atomically checkpointed. If an external call interrupts the sequence, rerun the same command with the recovery directory printed by the CLI:

```bash
npm run benchmark -- \
  --provider openai-codex \
  --model gpt-5.5 \
  --qodo-depth fast \
  --resume .factory-runs/benchmarks/<benchmark-id>
```

See [`docs/benchmark-protocol.md`](docs/benchmark-protocol.md) for the task order, metrics, comparison boundary, checkpoint invariants, and recovery contract.

## Evidence boundary

Every run writes its receipt and role artifacts under `.factory-runs/<run-id>/`. Those local artifacts are ignored by Git because they may contain machine-specific paths and raw agent event streams. Curate evidence deliberately before publishing it.

## Limits

- Pi tool allowlists are role controls, not an operating-system sandbox. Use a container or VM for untrusted repositories.
- This prototype does not commit, push, open PRs, publish comments, or apply Qodo findings.
- Receipt token and model-cost totals cover Pi only; the Qodo CLI result does not expose review cost.
- One task cannot establish a general reduction in escaped defects. A 5–10 task benchmark is still required.
- Repository visibility and Qodo workspace access remain separate gates. The successful run establishes access for the tested repository and account at that point in time, not permanent availability.
