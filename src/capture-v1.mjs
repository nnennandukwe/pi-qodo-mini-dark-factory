#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function parseFlags(tokens) {
  const flags = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("Expected paired command flags");
    flags[name.slice(2)] = value;
  }
  return flags;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
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

const flags = parseFlags(process.argv.slice(2));
if (!flags.multi || !flags.baseline || !flags.output) {
  throw new Error(
    "Usage: node src/capture-v1.mjs --multi <receipt> --baseline <receipt> --output <directory>",
  );
}

const output = path.resolve(flags.output);
await captureRun(path.resolve(flags.multi), path.join(output, "multi-agent"), { multi: true });
await captureRun(path.resolve(flags.baseline), path.join(output, "one-agent"), { multi: false });
process.stdout.write(`${JSON.stringify({ output })}\n`);
