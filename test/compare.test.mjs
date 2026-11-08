import assert from "node:assert/strict";
import { access, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../src/process.mjs";
import { cliWorkspace } from "./helpers/workspace.mjs";

async function comparisonWorkspace(t) {
  const workspace = await cliWorkspace(t);
  workspace.env.FACTORY_TEST_PI_SCENARIO = "happy";
  const receipts = [];
  for (const args of [
    ["run", "--runner", "pi", "--provider", "fixture", "--model", "fixture"],
    ["baseline", "--provider", "fixture", "--model", "fixture"],
  ]) {
    const result = await runCommand([process.execPath, "src/cli.mjs", ...args], workspace);
    assert.equal(result.exit_code, 0, result.stderr);
    receipts.push(JSON.parse(result.stdout).receipt);
  }
  const acceptance = await runCommand([process.execPath, "src/cli.mjs", "acceptance"], workspace);
  assert.equal(acceptance.exit_code, 0, acceptance.stderr);
  const [multi, baseline] = receipts;
  const output = path.join(workspace.cwd, "comparison.json");
  const compare = (target = output) => runCommand([
    process.execPath, "src/compare.mjs", "--multi", multi, "--baseline", baseline, "--output", target,
  ], workspace);
  return { ...workspace, multi, baseline, output, compare };
}

test("comparison rejects unrelated receipts and incomplete saved evidence, then recovers", async (t) => {
  const workspace = await comparisonWorkspace(t);
  const control = await workspace.compare();
  assert.equal(control.exit_code, 0, control.stderr);
  assert.equal(JSON.parse(control.stdout).graduate_to_qodo_v2, true);
  const multiVerification = path.join(path.dirname(workspace.multi), "verification.json");
  const baselineVerification = path.join(path.dirname(workspace.baseline), "verification.json");
  const cases = [
    ["different task", workspace.baseline, (receipt) => { receipt.task_id = "another-task"; }, "error"],
    ["changed task contract", path.join(path.dirname(workspace.baseline), "task.json"), (task) => { task.acceptance_criteria.push("Another requirement"); }, "error"],
    ["receipt base mismatch", workspace.baseline, (receipt) => { receipt.base_sha = "a".repeat(40); }],
    ["wrong verification patch", multiVerification, (verification) => { verification.patch_digest = "a".repeat(64); }],
    ["wrong verification task", baselineVerification, (verification) => { verification.task_id = "another-task"; }],
    ["wrong verification base", multiVerification, (verification) => { verification.base_sha = "a".repeat(40); }],
    ["missing gates", workspace.multi, (receipt) => { receipt.gates = []; }],
    ["missing review gate", workspace.multi, (receipt) => { receipt.gates = receipt.gates.filter((gate) => gate.name !== "review"); }],
    ["failed baseline gate", workspace.baseline, (receipt) => { receipt.gates.implementation.ok = false; }],
    ["optional-only checks", multiVerification, (verification) => { verification.checks.forEach((check) => { check.required = false; }); }],
    ["missing required check", baselineVerification, (verification) => { verification.checks.shift(); }],
    ["duplicate check", multiVerification, (verification) => { verification.checks.push(verification.checks[0]); }],
    ["incomplete verification", multiVerification, (verification) => { verification.evidence_complete = false; }],
    ["missing completion marker", baselineVerification, (verification) => { delete verification.evidence_complete; }],
    ["interrupted check", multiVerification, (verification) => { verification.checks[0].exit_code = null; verification.checks[0].signal = "SIGTERM"; }],
    ["timeout with zero exit", baselineVerification, (verification) => { verification.checks[0].timed_out = true; verification.checks[0].exit_code = 0; }],
  ];
  for (const [name, file, mutate, outcome] of cases) {
    await t.test(name, async () => {
      const original = await readFile(file, "utf8");
      const previousOutput = await readFile(workspace.output, "utf8");
      const record = JSON.parse(original);
      mutate(record);
      await writeFile(file, JSON.stringify(record));
      try {
        const result = await workspace.compare();
        if (outcome === "error") {
          assert.equal(result.exit_code, 1, result.stderr || result.stdout);
          assert.equal(result.stdout, "");
          assert.match(result.stderr, /same task|matching task/);
          assert.equal(await readFile(workspace.output, "utf8"), previousOutput);
        } else {
          assert.equal(result.exit_code, 0, result.stderr);
          assert.equal(JSON.parse(result.stdout).graduate_to_qodo_v2, false, name);
          const comparison = JSON.parse(await readFile(workspace.output, "utf8"));
          assert.ok(comparison.graduation.reasons.length > 0);
        }
      } finally {
        await writeFile(file, original);
      }
      const recovered = await workspace.compare();
      assert.equal(recovered.exit_code, 0, recovered.stderr);
      assert.equal(JSON.parse(recovered.stdout).graduate_to_qodo_v2, true);
    });
  }
});

test("comparison names malformed inputs, preserves prior output, and accepts help-named output paths", async (t) => {
  const workspace = await comparisonWorkspace(t);
  for (const target of ["--help", "-h", "--comparison.json"]) {
    const result = await workspace.compare(target);
    assert.equal(result.exit_code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).graduate_to_qodo_v2, true);
    assert.equal(JSON.parse(await readFile(path.join(workspace.cwd, target), "utf8")).task_id,
      JSON.parse(await readFile(workspace.multi, "utf8")).task_id);
  }
  assert.equal((await workspace.compare()).exit_code, 0);
  for (const file of [workspace.multi, workspace.baseline,
    path.join(path.dirname(workspace.multi), "verification.json"),
    path.join(path.dirname(workspace.baseline), "verification.json"),
    path.join(path.dirname(workspace.multi), "task.json"),
    path.join(workspace.cwd, "evidence/v1/scripted-acceptance.json")]) {
    const original = await readFile(file, "utf8");
    const output = await readFile(workspace.output, "utf8");
    await writeFile(file, "{invalid");
    try {
      const result = await workspace.compare();
      assert.equal(result.exit_code, 1);
      assert.equal(result.stdout, "");
      assert.ok(result.stderr.includes(file), result.stderr);
      assert.match(result.stderr, /Repair this file and retry/);
      assert.doesNotMatch(result.stderr, /\n\s+at /);
      assert.equal(await readFile(workspace.output, "utf8"), output);
    } finally {
      await writeFile(file, original);
    }
    assert.equal((await workspace.compare()).exit_code, 0);
  }
});

test("run treats help tokens in task path positions as paths", async (t) => {
  const workspace = await cliWorkspace(t);
  const argv = [process.execPath, "src/cli.mjs", "run", "--task", "--help"];
  const missing = await runCommand(argv, workspace);
  assert.equal(missing.exit_code, 1);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /ENOENT.*--help/);
  await assert.rejects(access(path.join(workspace.cwd, ".factory-runs")), { code: "ENOENT" });
  await copyFile(path.join(workspace.cwd, "tasks/reject-expired-session-token.json"), path.join(workspace.cwd, "--help"));
  const recovered = await runCommand(argv, workspace);
  assert.equal(recovered.exit_code, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).terminal_status, "COMPLETE");
});
