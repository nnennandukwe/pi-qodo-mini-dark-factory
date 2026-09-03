import { readFile } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "./process.mjs";

const ROLE_TOOLS = Object.freeze({
  planner: ["read", "grep", "find", "ls"],
  implementer: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  reviewer: ["read", "grep", "find", "ls"],
  baseline: ["read", "grep", "find", "ls", "bash", "edit", "write"],
});

function assistantTextFromEvents(raw) {
  const messages = [];
  const usage = {
    input: 0,
    output: 0,
    cache_read: 0,
    cache_write: 0,
    cost_usd: 0,
    turns: 0,
  };
  let model;
  let stopReason;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "message_end" || !event.message || event.message.role !== "assistant") continue;
    messages.push(event.message);
    usage.turns += 1;
    usage.input += event.message.usage?.input ?? 0;
    usage.output += event.message.usage?.output ?? 0;
    usage.cache_read += event.message.usage?.cacheRead ?? 0;
    usage.cache_write += event.message.usage?.cacheWrite ?? 0;
    usage.cost_usd += event.message.usage?.cost?.total ?? 0;
    model = event.message.model ?? model;
    stopReason = event.message.stopReason ?? stopReason;
  }

  const last = messages.at(-1);
  const text = last?.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return { text: text ?? "", usage, model, stop_reason: stopReason };
}

function parseStrictJson(text, role) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error(`${role} did not return a single JSON object`);
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${role} returned invalid JSON: ${error.message}`);
  }
}

export class PiRunner {
  constructor({ projectRoot, provider, model, thinking = "medium", piBin = "pi" }) {
    this.projectRoot = projectRoot;
    this.provider = provider;
    this.model = model;
    this.thinking = thinking;
    this.piBin = piBin;
  }

  async run(role, { cwd, input }) {
    const tools = ROLE_TOOLS[role];
    if (!tools) throw new Error(`Unknown Pi role: ${role}`);
    const rolePrompt = path.join(this.projectRoot, "roles", `${role}.md`);
    const args = [
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-extensions",
      "--no-approve",
      "--tools",
      tools.join(","),
      "--thinking",
      this.thinking,
      "--append-system-prompt",
      rolePrompt,
    ];
    if (this.provider) args.push("--provider", this.provider);
    if (this.model) args.push("--model", this.model);
    args.push(`Task input:\n${JSON.stringify(input, null, 2)}`);

    const command = await runCommand([this.piBin, ...args], {
      cwd,
      env: process.env,
      timeoutMs: 10 * 60_000,
    });
    const parsed = assistantTextFromEvents(command.stdout);
    if (command.exit_code !== 0 || parsed.stop_reason === "error" || parsed.stop_reason === "aborted") {
      throw new Error(
        `${role} Pi process failed: ${command.stderr || parsed.text || `exit ${command.exit_code}`}`,
      );
    }
    const output = parseStrictJson(parsed.text, role);
    return {
      output,
      evidence: {
        role,
        tools,
        provider: this.provider ?? null,
        model: parsed.model ?? this.model ?? null,
        usage: parsed.usage,
        command: {
          exit_code: command.exit_code,
          duration_ms: command.duration_ms,
          stop_reason: parsed.stop_reason ?? null,
        },
        final_output: parsed.text,
        raw_event_stream: command.stdout,
        stderr: command.stderr,
      },
    };
  }
}

export async function assertPiAvailable(piBin = "pi") {
  const version = await runCommand([piBin, "--version"]);
  if (version.exit_code !== 0) throw new Error(`Pi is unavailable: ${version.stderr}`);
  const packageJson = JSON.parse(
    await readFile(path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8").catch(() => "{}"),
  );
  return { cli_version: version.stdout.trim(), package_version: packageJson.version ?? null };
}
