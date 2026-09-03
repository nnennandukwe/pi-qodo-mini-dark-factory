import { writeFile } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "./process.mjs";

const ACTION_SEVERITIES = new Map([
  ["action_required", "high"],
  ["remediation_recommended", "medium"],
  ["informational", "low"],
]);

function parseJson(text, label) {
  try {
    return JSON.parse(text.trim());
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function severityFor(finding) {
  const direct = finding.severity;
  if (["low", "medium", "high", "critical"].includes(direct)) return direct;
  return ACTION_SEVERITIES.get(finding.action_level ?? finding.severity_level) ?? "medium";
}

function fileFor(finding) {
  return (
    finding.diff_reference?.file_path ??
    finding.diff_pointer?.file_path ??
    finding.file_path ??
    "repository"
  );
}

export function normalizeQodoReview(result, task) {
  if (!result || !Array.isArray(result.findings)) {
    throw new Error("Qodo result did not contain a findings array");
  }
  const findings = result.findings.map((finding) => ({
    severity: severityFor(finding),
    summary: finding.title ?? finding.finding_title ?? finding.description ?? "Untitled Qodo finding",
    file: fileFor(finding),
    category: finding.category ?? null,
    action_level: finding.action_level ?? finding.severity_level ?? finding.severity ?? null,
  }));
  const ran = result.meta?.reviewers?.ran;
  const evidenceSufficient = !Array.isArray(ran) || ran.length > 0;
  const hasBlockingFinding = findings.some((finding) =>
    ["high", "critical"].includes(finding.severity),
  );
  return {
    task_id: task.id,
    decision: hasBlockingFinding ? "request_changes" : "approve",
    evidence_sufficient: evidenceSufficient,
    findings,
    skipped_checks: evidenceSufficient ? [] : ["Qodo reported that no review dimensions ran"],
    provider: "qodo",
    coverage: result.meta ?? null,
  };
}

function relayProgressLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (event.kind === "cli.status" && event.message) {
    process.stderr.write(`Qodo: ${event.message}\n`);
    return;
  }
  if (event.kind === "tool.activity") {
    const payload = event.payload ?? {};
    process.stderr.write(`Qodo: ${payload.tool_name ?? "tool"}: ${payload.outcome ?? "update"}\n`);
    return;
  }
  if (event.kind === "task.done") {
    process.stderr.write(`Qodo: review ${event.payload?.status ?? "finished"}\n`);
    return;
  }
  if (event.kind === "error") {
    process.stderr.write(`Qodo: review signaled ${event.payload?.code ?? "an error"}; awaiting result\n`);
  }
}

function contextFor(input) {
  const passedChecks = input.verification.checks
    .filter((check) => check.required && check.exit_code === 0)
    .map((check) => check.id);
  return {
    summary: `${input.task.title}. ${input.implementation.summary}`,
    decisions: [
      `The task is intentionally limited to ${input.task.files_allowed.join(", ")}.`,
      `The implementation must preserve these constraints: ${input.task.constraints.join("; ")}.`,
      `Independent deterministic verification passed: ${passedChecks.join(", ")}.`,
    ],
  };
}

export class QodoReviewer {
  constructor({ qodoBin = "qodo", depth = "fast" } = {}) {
    if (!["fast", "deep"].includes(depth)) throw new Error("Qodo depth must be fast or deep");
    this.qodoBin = qodoBin;
    this.depth = depth;
    this.readyRepository = null;
    this.cliVersion = null;
  }

  async preflight({ cwd, repository }) {
    if (!repository) throw new Error("Qodo review requires task.repository metadata");
    const version = await runCommand([this.qodoBin, "--version"], { cwd });
    if (version.exit_code !== 0) throw new Error(`Qodo is unavailable: ${version.stderr}`);
    const auth = await runCommand([this.qodoBin, "whoami", "--json", "--skill", "qodo-review"], {
      cwd,
    });
    if (auth.exit_code !== 0) {
      throw new Error("Qodo authentication failed. Run `qodo login`, then retry the workflow.");
    }
    const inventory = await runCommand(
      [
        this.qodoBin,
        "codebase",
        "search-repos",
        "--query",
        repository.repo_full_name,
        "--max-results",
        "50",
        "--json",
      ],
      { cwd, timeoutMs: 60_000 },
    );
    const inventoryResult = parseJson(inventory.stdout, "Qodo repository inventory");
    if (inventory.exit_code !== 0 || inventoryResult.error) {
      throw new Error(
        `Qodo repository inventory failed: ${inventoryResult.error?.message ?? inventory.stderr}`,
      );
    }
    const connected = inventoryResult.repos?.some(
      (repo) => repo.full_name?.toLowerCase() === repository.repo_full_name.toLowerCase(),
    );
    if (!connected) {
      throw new Error(
        `${repository.repo_full_name} is not connected to the active Qodo workspace. Connect it before running the workflow.`,
      );
    }
    this.readyRepository = repository.repo_full_name;
    this.cliVersion = version.stdout.trim();
    return { cli_version: this.cliVersion, repository_connected: true };
  }

  async run(role, { cwd, input, artifactsDir }) {
    if (role !== "reviewer") throw new Error(`Qodo only supports the reviewer role, not ${role}`);
    if (this.readyRepository !== input.task.repository?.repo_full_name) {
      await this.preflight({ cwd, repository: input.task.repository });
    }

    const contextPath = path.join(artifactsDir, "qodo-context.json");
    const resultPath = path.join(artifactsDir, "qodo-review-result.json");
    const progressPath = path.join(artifactsDir, "qodo-review-progress.ndjson");
    await writeFile(contextPath, `${JSON.stringify(contextFor(input), null, 2)}\n`);

    let pending = "";
    const command = await runCommand(
      [
        this.qodoBin,
        "review",
        "--json",
        "--progress",
        `--${this.depth}`,
        "--base",
        input.task.repository.base_ref,
        "--repo",
        input.task.repository.repo_full_name,
        "--context-file",
        contextPath,
        ...input.task.files_allowed,
      ],
      {
        cwd,
        timeoutMs: 10 * 60_000,
        onStderr(chunk) {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) relayProgressLine(line);
        },
      },
    );
    if (pending.trim()) relayProgressLine(pending);
    await writeFile(resultPath, command.stdout);
    await writeFile(progressPath, command.stderr);

    const rawResult = parseJson(command.stdout, "Qodo review");
    if (rawResult.error) {
      const code = rawResult.error.code ? `${rawResult.error.code}: ` : "";
      const hint = rawResult.error.hint ? ` ${rawResult.error.hint}` : "";
      throw new Error(`${code}${rawResult.error.message}${hint}`);
    }
    if (command.exit_code !== 0) {
      throw new Error(`Qodo review exited ${command.exit_code} without an error envelope`);
    }

    return {
      output: normalizeQodoReview(rawResult, input.task),
      evidence: {
        role: "reviewer",
        provider: "qodo",
        tools: [],
        cli_version: this.cliVersion,
        review_depth: this.depth,
        base_ref: input.task.repository.base_ref,
        repository: input.task.repository.repo_full_name,
        usage: { input: 0, output: 0, cost_usd: 0, turns: 0 },
        command: {
          exit_code: command.exit_code,
          duration_ms: command.duration_ms,
        },
        result_artifact: path.basename(resultPath),
        progress_artifact: path.basename(progressPath),
      },
    };
  }
}
