import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../src/process.mjs";
import { PiRunner } from "../src/pi-runner.mjs";
import { QodoReviewer } from "../src/qodo-runner.mjs";
import { initializeRepository, patchEvidence } from "../src/git.mjs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { executable, temporaryDirectory } from "./helpers/workspace.mjs";

test("bounded process capture reports truncation on each stream", async () => {
  const result = await runCommand([process.execPath, "-e",
    'process.stdout.write("START" + "x".repeat(300000)); process.stderr.write("y".repeat(300000));',
  ]);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout.length, 262144);
  assert.equal(result.stderr.length, 262144);
  assert.equal(result.stdout_truncated, true);
  assert.equal(result.stderr_truncated, true);
});

test("complete capture preserves split UTF-8 and reports no truncation", async () => {
  const result = await runCommand([process.execPath, "-e",
    'const b = Buffer.from("\u{1f642}"); process.stdout.write(b.subarray(0, 2)); setTimeout(() => process.stdout.write(b.subarray(2)), 30);',
  ]);
  assert.equal(result.stdout, "\u{1f642}");
  assert.equal(result.stdout_truncated, false);
  assert.equal(result.stderr_truncated, false);
});

test("Pi rejects truncated event evidence even when the final JSON survives", async (t) => {
  const directory = await temporaryDirectory(t);
  const piBin = await executable(directory, "pi.mjs", `
const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"ok":true}' }], usage: { input: 100, output: 10 }, stopReason: "stop" } };
console.log(JSON.stringify(event));
console.log(JSON.stringify({ type: "message_update", padding: "x".repeat(300000) }));
console.log(JSON.stringify(event));
`);
  const runner = new PiRunner({ projectRoot: directory, piBin });
  await assert.rejects(runner.run("planner", { cwd: directory, input: {} }), /capture limit.*evidence is incomplete/i);
});

test("Git evidence refuses a truncated patch instead of hashing its tail", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "source.txt");
  await writeFile(source, "before\n");
  const baseline = await initializeRepository(directory);
  await writeFile(source, "after\n");
  assert.match((await patchEvidence(directory, baseline)).patch, /\+after/);
  await writeFile(source, "after\n".repeat(50000));
  await assert.rejects(patchEvidence(directory, baseline), /git diff output exceeded the capture limit/);
});

test("Qodo rejects oversized capture even when the remaining JSON parses", async (t) => {
  const directory = await temporaryDirectory(t);
  const qodoBin = await executable(directory, "qodo.mjs", `
process.stdout.write(" ".repeat(300000) + JSON.stringify({ findings: [] }));
`);
  const reviewer = new QodoReviewer({ qodoBin });
  reviewer.readyRepository = "fixture/repo";
  await assert.rejects(reviewer.run("reviewer", {
    cwd: directory,
    artifactsDir: directory,
    input: {
      task: { id: "fixture", title: "Fixture", repository: { repo_full_name: "fixture/repo", base_ref: "HEAD" }, files_allowed: [], constraints: [] },
      implementation: { summary: "Fixture" },
      verification: { checks: [] },
    },
  }), /Qodo review output exceeded the capture limit/);
});
