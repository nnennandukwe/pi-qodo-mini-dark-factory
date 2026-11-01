#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const HELP = `Usage: node src/capture-v1.mjs --multi <receipt> --baseline <receipt> --output <directory>

Export saved v1 workflow and baseline artifacts with agent summaries.
Raw agent event streams are omitted from the summaries.
`;

function parseFlags(tokens) {
  const flags = {};
  const allowed = new Set(["multi", "baseline", "output"]);
  for (let index = 0; index < tokens.length; index += 2) {
    const token = tokens[index];
    if (["--help", "-h"].includes(token)) return { help: true };
    const name = token?.slice(2);
    if (!token?.startsWith("--") || !allowed.has(name)) {
      throw new Error(`Unknown option: ${token}. Use --help for export usage.`);
    }
    const value = tokens[index + 1];
    if (!value || (value.startsWith("--") && allowed.has(value.slice(2)))) throw new Error(`Missing value for ${token}. Use --help for export usage.`);
    if (Object.hasOwn(flags, name)) throw new Error(`Repeated option: ${token}. Supply each path once.`);
    flags[name] = value;
  }
  return flags;
}

async function readJson(file) {
  const contents = await readFile(file, "utf8");
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error.message}. Repair this file and retry the export.`, { cause: error });
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function captureRun(receiptPath, destination, { multi }) {
  const receipt = await readJson(receiptPath);
  const artifacts = path.dirname(receiptPath);
  await mkdir(destination, { recursive: true });
  await cp(receiptPath, path.join(destination, "receipt.json"));
  for (const [name, relative] of Object.entries(receipt.artifact_paths)) {
    if (name === "agent") continue;
    const source = path.join(path.dirname(artifacts), relative);
    const target = path.join(destination, path.basename(relative));
    await cp(source, target);
  }

  if (multi) {
    const roleSummaries = {};
    for (const role of ["planner", "implementer", "reviewer"]) {
      const evidence = await readJson(path.join(artifacts, "agents", `${role}.json`));
      const { raw_event_stream: _raw, ...summary } = evidence;
      roleSummaries[role] = summary;
    }
    await writeJson(path.join(destination, "role-summaries.json"), roleSummaries);
  } else {
    const evidence = await readJson(path.join(artifacts, "agent.json"));
    const { raw_event_stream: _raw, ...summary } = evidence;
    await writeJson(path.join(destination, "agent-summary.json"), summary);
  }
}

async function main(tokens) {
  const flags = parseFlags(tokens);
  if (flags.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!flags.multi || !flags.baseline || !flags.output) {
    throw new Error("Supply --multi <receipt>, --baseline <receipt>, and --output <directory>.");
  }

  const output = path.resolve(flags.output);
  await captureRun(path.resolve(flags.multi), path.join(output, "multi-agent"), { multi: true });
  await captureRun(path.resolve(flags.baseline), path.join(output, "one-agent"), { multi: false });
  process.stdout.write(`${JSON.stringify({ output })}\n`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\nRun with --help for usage.\n`);
  process.exitCode = 1;
}
