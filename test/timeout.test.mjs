import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runBaseline } from "../src/baseline.mjs";
import { runPilot } from "../src/controller.mjs";
import { PiRunner } from "../src/pi-runner.mjs";
import { QodoReviewer } from "../src/qodo-runner.mjs";
import { runCommand } from "../src/process.mjs";
import { ScriptedRunner } from "../src/scripted-runner.mjs";
import { cliWorkspace, executable, temporaryDirectory } from "./helpers/workspace.mjs";

const cleanupSuccess = 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);';

test("process deadlines preserve the child exit while rejecting cleanup success", async () => {
  for (const [source, timedOut, exitCode] of [
    ["process.exit(0)", false, 0],
    ["setInterval(() => {}, 1000)", true, 1],
    [cleanupSuccess, true, 0],
  ]) {
    const result = await runCommand([process.execPath, "-e", source], { timeoutMs: 600 });
    assert.equal(result.timed_out, timedOut);
    assert.equal(result.exit_code, exitCode);
  }
});

for (const kind of ["controller", "baseline"]) {
  for (const [label, source, success] of [
    ["normal success", "process.exit(0)", true],
    ["nonzero exit", "process.exit(7)", false],
    ["timeout with cleanup exit zero", cleanupSuccess, false],
  ]) {
    test(`${kind} gates ${label} through actual verification processes`, async (t) => {
      const workspace = await cliWorkspace(t);
      const taskPath = path.join(workspace.cwd, "tasks/reject-expired-session-token.json");
      const task = JSON.parse(await readFile(taskPath, "utf8"));
      task.verification = [{ id: "deadline-check", argv: [process.execPath, "-e", source], required: true }];
      await writeFile(taskPath, JSON.stringify(task));
      const scripted = new ScriptedRunner();
      const runner = { run: (role, context) => scripted.run(role === "baseline" ? "implementer" : role, context) };
      const options = { projectRoot: workspace.cwd, taskPath, runner, verificationTimeoutMs: 600 };
      const result = kind === "controller"
        ? await runPilot({ ...options, runnerName: "scripted" })
        : await runBaseline(options);
      assert.equal(result.receipt.success, success);
      const verification = JSON.parse(await readFile(path.join(result.artifactsDir, "verification.json"), "utf8"));
      if (label.startsWith("timeout")) {
        assert.equal(verification.checks[0].exit_code, 0);
        assert.equal(verification.checks[0].timed_out, true);
      }
      if (!success && kind === "controller") {
        assert.equal(result.receipt.terminal_status, "VERIFICATION_FAILED");
        assert.equal(result.receipt.verified_subject, null);
        await assert.rejects(access(path.join(result.artifactsDir, "review.json")), { code: "ENOENT" });
      }
    });
  }
}

test("Pi and Qodo adapters reject valid-looking output after a deadline", async (t) => {
  const directory = await temporaryDirectory(t);
  const binary = await executable(directory, "cleanup.mjs", `
process.on("SIGTERM", () => {
  console.log(JSON.stringify({ findings: [] }));
  process.exit(0);
});
setInterval(() => {}, 1000);
`);
  const pi = new PiRunner({ projectRoot: directory, piBin: binary, timeoutMs: 600 });
  await assert.rejects(pi.run("planner", { cwd: directory, input: {} }), /timed out; evidence is incomplete/);
  const qodo = new QodoReviewer({ qodoBin: binary, timeoutMs: 600 });
  qodo.readyRepository = "fixture/repo";
  await assert.rejects(qodo.run("reviewer", {
    cwd: directory, artifactsDir: directory,
    input: {
      task: { id: "fixture", title: "Fixture", repository: { repo_full_name: "fixture/repo", base_ref: "HEAD" }, files_allowed: [], constraints: [] },
      implementation: { summary: "Fixture" }, verification: { checks: [] },
    },
  }), /timed out; evidence is incomplete/);
});
