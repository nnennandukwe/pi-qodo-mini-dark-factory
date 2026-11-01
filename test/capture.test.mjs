import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../src/process.mjs";
import { projectRoot, temporaryDirectory } from "./helpers/workspace.mjs";

const capture = path.join(projectRoot, "src/capture-v1.mjs");

test("capture help and invalid flags use CLI streams without creating output", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const help of ["--help", "-h"]) {
    const result = await runCommand([process.execPath, capture, help], { cwd: directory });
    assert.equal(result.exit_code, 0, result.stderr);
    assert.match(result.stdout, /Usage:.*--multi.*--baseline.*--output/);
    assert.equal(result.stderr, "");
  }
  const output = path.join(directory, "export");
  for (const flags of [[], ["--multi"], ["--multi", "--baseline"], ["--unknown", "x"],
    ["--multi", "x", "--multi", "y"], ["unexpected", "x"]]) {
    const result = await runCommand([process.execPath, capture, ...flags, "--output", output], { cwd: directory });
    assert.equal(result.exit_code, 1, flags.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Error:.*\nRun with --help for usage\./);
    assert.doesNotMatch(result.stderr, /\n\s+at |node:internal|file:\/\//);
    await assert.rejects(access(output), { code: "ENOENT" });
  }
});

test("capture reports unreadable receipts and a corrected retry exports summaries", async (t) => {
  const directory = await temporaryDirectory(t);
  const output = path.join(directory, "export");
  const multi = path.join(directory, "multi/artifacts/receipt.json");
  const baseline = path.join(directory, "baseline/artifacts/receipt.json");
  const argv = [process.execPath, capture, "--multi", multi, "--baseline", baseline, "--output", output];
  const missing = await runCommand(argv, { cwd: directory });
  assert.equal(missing.exit_code, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /ENOENT.*receipt.json/);
  assert.match(missing.stderr, /Run with --help for usage/);
  assert.doesNotMatch(missing.stderr, /\n\s+at |node:internal/);
  await assert.rejects(access(output), { code: "ENOENT" });
  for (const receipt of [multi, baseline]) {
    const artifacts = path.dirname(receipt);
    await mkdir(path.join(artifacts, "agents"), { recursive: true });
    await writeFile(receipt, JSON.stringify({ artifact_paths: { verification: "artifacts/verification.json" } }));
    await writeFile(path.join(artifacts, "verification.json"), JSON.stringify({ passed: true }));
    for (const name of ["agent.json", "agents/planner.json", "agents/implementer.json", "agents/reviewer.json"]) {
      await writeFile(path.join(artifacts, name), JSON.stringify({ usage: { input: 12 }, raw_event_stream: "private events" }));
    }
  }
  const malformed = "{invalid";
  await writeFile(multi, malformed);
  const invalid = await runCommand(argv, { cwd: directory });
  assert.equal(invalid.exit_code, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /Run with --help for usage/);
  assert.doesNotMatch(invalid.stderr, /\n\s+at /);
  await assert.rejects(access(output), { code: "ENOENT" });
  await writeFile(multi, JSON.stringify({ artifact_paths: { verification: "artifacts/verification.json" } }));
  const result = await runCommand(argv, { cwd: directory });
  assert.equal(result.exit_code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { output });
  assert.equal(result.stderr, "");
  for (const kind of ["multi-agent", "one-agent"]) {
    assert.deepEqual(JSON.parse(await readFile(path.join(output, kind, "verification.json"), "utf8")), { passed: true });
  }
  const roles = JSON.parse(await readFile(path.join(output, "multi-agent/role-summaries.json"), "utf8"));
  assert.deepEqual(Object.keys(roles), ["planner", "implementer", "reviewer"]);
  assert.equal(roles.planner.raw_event_stream, undefined);
  const agent = JSON.parse(await readFile(path.join(output, "one-agent/agent-summary.json"), "utf8"));
  assert.deepEqual(agent, { usage: { input: 12 } });
});
