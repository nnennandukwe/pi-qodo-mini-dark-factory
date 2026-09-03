# Pi x Qodo Mini Dark Factory

> **Pilot harness — inspectable engineering workflow, not production automation.**

This repository tests one narrow question: does explicit role separation make an agentic code change easier to inspect without allowing agent confidence to replace executable evidence?

The controller separates planning, implementation, deterministic verification, and semantic review. Only the controller advances the workflow. The public Qodo path is prepared but not yet proven end to end; `nnennandukwe/pi-qodo-quality-fixture` must first be connected to the active Qodo workspace.

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

Qodo requires a logged-in CLI and a base repository connected to the active Qodo workspace. Connect [`nnennandukwe/pi-qodo-quality-fixture`](https://github.com/nnennandukwe/pi-qodo-quality-fixture) before running this path. The base commit stays available on GitHub; the implementation remains local and unpushed.

```bash
qodo whoami --json --skill qodo-review
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

## Evidence boundary

Every run writes its receipt and role artifacts under `.factory-runs/<run-id>/`. Those local artifacts are ignored by Git because they may contain machine-specific paths and raw agent event streams. Curate evidence deliberately before publishing it.

## Limits

- Pi tool allowlists are role controls, not an operating-system sandbox. Use a container or VM for untrusted repositories.
- This prototype does not commit, push, open PRs, publish comments, or apply Qodo findings.
- Receipt token and model-cost totals cover Pi only; the Qodo CLI result does not expose review cost.
- One task cannot establish a general reduction in escaped defects. A 5–10 task benchmark is still required.
- Public repository visibility does not prove Qodo workspace access. Treat connection and successful review as separate gates.
