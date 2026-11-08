import assert from "node:assert/strict";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../src/process.mjs";
import { runPilot } from "../src/controller.mjs";
import { runBaseline } from "../src/baseline.mjs";
import { ScriptedRunner } from "../src/scripted-runner.mjs";
import { cliWorkspace } from "./helpers/workspace.mjs";

async function comparisonWorkspace(t, configureTask = null) {
  const workspace = await cliWorkspace(t);
  workspace.env.FACTORY_TEST_PI_SCENARIO = "happy";
  const taskFlags = [];
  if (configureTask) {
    const task = JSON.parse(await readFile(path.join(workspace.cwd, "tasks/reject-expired-session-token.json"), "utf8"));
    configureTask(task);
    const taskPath = path.join(workspace.cwd, "comparison-task.json");
    await writeFile(taskPath, JSON.stringify(task));
    taskFlags.push("--task", taskPath);
  }
  const receipts = [];
  for (const args of [
    ["run", "--runner", "pi", "--provider", "fixture", "--model", "fixture"],
    ["baseline", "--provider", "fixture", "--model", "fixture"],
  ]) {
    const result = await runCommand([process.execPath, "src/cli.mjs", ...args, ...taskFlags], workspace);
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
  for (const file of [multiVerification, baselineVerification]) {
    const original = await readFile(file, "utf8");
    const legacy = JSON.parse(original);
    delete legacy.harness_root;
    await writeFile(file, JSON.stringify(legacy));
    const result = await workspace.compare();
    assert.equal(result.exit_code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).graduate_to_qodo_v2, true);
    await writeFile(file, original);
  }
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
    ["wrong check command", multiVerification, (verification) => { verification.checks[1].argv = ["node", "--version"]; }],
    ["missing check command", baselineVerification, (verification) => { delete verification.checks[0].argv; }],
    ["wrong oracle root", multiVerification, (verification) => { verification.checks[0].argv[2] = "/other/oracles/session-expiry.mjs"; }],
    ["interrupted check", multiVerification, (verification) => { verification.checks[0].exit_code = null; verification.checks[0].signal = "SIGTERM"; }],
    ["timeout with zero exit", baselineVerification, (verification) => { verification.checks[0].timed_out = true; verification.checks[0].exit_code = 0; }],
    ...["timed_out", "spawn_error", "stdout_truncated", "stderr_truncated"].map((marker) =>
      [`missing ${marker}`, multiVerification, (verification) => { delete verification.checks[0][marker]; }]),
    ["invalid timeout marker", baselineVerification, (verification) => { verification.checks[0].timed_out = 0; }],
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

test("comparison preserves successful tasks with only optional checks", async (t) => {
  const workspace = await comparisonWorkspace(t, (task) => {
    task.verification.forEach((check) => { check.required = false; });
  });
  const result = await workspace.compare();
  assert.equal(result.exit_code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).graduate_to_qodo_v2, true);
  const file = path.join(path.dirname(workspace.multi), "verification.json");
  const original = await readFile(file, "utf8");
  for (const field of ["timed_out", "spawn_error", "stdout_truncated", "stderr_truncated", "exit_code"]) {
    const verification = JSON.parse(original);
    delete verification.checks[0][field];
    await writeFile(file, JSON.stringify(verification));
    assert.equal(JSON.parse((await workspace.compare()).stdout).graduate_to_qodo_v2, false, field);
  }
  await writeFile(file, original);
  assert.equal(JSON.parse((await workspace.compare()).stdout).graduate_to_qodo_v2, true);
});

test("comparison requires identical fixture contents and recovers after restoring them", async (t) => {
  const workspace = await comparisonWorkspace(t);
  assert.equal(JSON.parse((await workspace.compare()).stdout).graduate_to_qodo_v2, true);
  const previousOutput = await readFile(workspace.output, "utf8");
  const extraFile = path.join(workspace.cwd, "fixtures/token-service/different-source.txt");
  await writeFile(extraFile, "This fixture has different starting contents.\n");
  const baselineArgs = [process.execPath, "src/cli.mjs", "baseline", "--provider", "fixture", "--model", "fixture"];
  const changed = await runCommand(baselineArgs, workspace);
  assert.equal(changed.exit_code, 0, changed.stderr);
  const compareWith = (receipt) => runCommand([process.execPath, "src/compare.mjs", "--multi", workspace.multi,
    "--baseline", receipt, "--output", workspace.output], workspace);
  const rejected = await compareWith(JSON.parse(changed.stdout).receipt);
  assert.equal(rejected.exit_code, 1, rejected.stderr || rejected.stdout);
  assert.match(rejected.stderr, /matching fixture contents/);
  assert.equal(await readFile(workspace.output, "utf8"), previousOutput);
  await rm(extraFile);
  const recovered = await runCommand(baselineArgs, { ...workspace, env: { ...workspace.env,
    GIT_AUTHOR_DATE: "2001-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2001-01-01T00:00:00Z" } });
  assert.equal(recovered.exit_code, 0, recovered.stderr);
  const restoredReceipt = JSON.parse(recovered.stdout).receipt;
  const restored = JSON.parse(await readFile(restoredReceipt, "utf8"));
  assert.notEqual(restored.base_sha, JSON.parse(await readFile(workspace.multi, "utf8")).base_sha);
  assert.equal(JSON.parse((await compareWith(restoredReceipt)).stdout).graduate_to_qodo_v2, true);
  const repo = path.join(path.dirname(path.dirname(restoredReceipt)), "repo");
  await rename(repo, `${repo}-saved`);
  const missing = await compareWith(restoredReceipt);
  assert.equal(missing.exit_code, 1);
  assert.match(missing.stderr, /Restore the run repository/);
  await rename(`${repo}-saved`, repo);
  assert.equal(JSON.parse((await compareWith(restoredReceipt)).stdout).graduate_to_qodo_v2, true);
});

test("comparison checks saved tracked patches and preserves output on missing files", async (t) => {
  const workspace = await comparisonWorkspace(t);
  assert.equal((await workspace.compare()).exit_code, 0);
  for (const receipt of [workspace.multi, workspace.baseline]) {
    const patchPath = path.join(path.dirname(receipt), "diff.patch");
    const original = await readFile(patchPath);
    const previousOutput = await readFile(workspace.output);
    await rm(patchPath);
    const missing = await workspace.compare();
    assert.equal(missing.exit_code, 1);
    assert.ok(missing.stderr.includes(patchPath));
    assert.deepEqual(await readFile(workspace.output), previousOutput);
    await writeFile(patchPath, "another patch\n");
    const replaced = await workspace.compare();
    assert.equal(replaced.exit_code, 0, replaced.stderr);
    assert.equal(JSON.parse(replaced.stdout).graduate_to_qodo_v2, false);
    await writeFile(patchPath, original);
    const restored = await workspace.compare();
    assert.equal(restored.exit_code, 0, restored.stderr);
    assert.equal(JSON.parse(restored.stdout).graduate_to_qodo_v2, true);
  }
});

test("comparison binds untracked content and supports relocated run directories", async (t) => {
  const workspace = await cliWorkspace(t);
  const task = JSON.parse(await readFile(path.join(workspace.cwd, "tasks/reject-expired-session-token.json"), "utf8"));
  task.files_allowed.push("notes.txt");
  task.verification = [task.verification[0]];
  const taskPath = path.join(workspace.cwd, "untracked-task.json");
  await writeFile(taskPath, JSON.stringify(task));
  const scripted = new ScriptedRunner();
  const runner = { run: async (role, context) => {
    const result = await scripted.run(role === "baseline" ? "implementer" : role, context);
    if (["implementer", "baseline"].includes(role)) {
      await writeFile(path.join(context.cwd, "notes.txt"), "verified notes\n");
      result.output.changed_files.push("notes.txt");
    }
    return result;
  } };
  const options = { projectRoot: workspace.cwd, taskPath, runner };
  const multi = await runPilot({ ...options, runnerName: "scripted" });
  const baseline = await runBaseline(options);
  assert.equal(multi.receipt.success, true);
  assert.equal(baseline.receipt.success, true);
  const acceptance = await runCommand([process.execPath, "src/cli.mjs", "acceptance"], workspace);
  assert.equal(acceptance.exit_code, 0, acceptance.stderr);
  const archive = path.join(workspace.cwd, "archive/retained-runs");
  await mkdir(path.dirname(archive));
  await rename(path.join(workspace.cwd, ".factory-runs"), archive);
  const compare = () => runCommand([
    process.execPath, "src/compare.mjs", "--multi", path.join(archive, multi.receipt.run_id, "artifacts/receipt.json"),
    "--baseline", path.join(archive, baseline.receipt.run_id, "artifacts/receipt.json"), "--output", "comparison.json",
  ], workspace);
  assert.equal(JSON.parse((await compare()).stdout).graduate_to_qodo_v2, true);
  for (const result of [multi, baseline]) {
    const notes = path.join(archive, result.receipt.run_id, "repo/notes.txt");
    await writeFile(notes, "changed after verification\n");
    const changed = await compare();
    assert.equal(changed.exit_code, 0, changed.stderr);
    assert.equal(JSON.parse(changed.stdout).graduate_to_qodo_v2, false);
    await writeFile(notes, "verified notes\n");
    assert.equal(JSON.parse((await compare()).stdout).graduate_to_qodo_v2, true);
  }
});

test("both runners reject duplicate verification IDs before writing runs", async (t) => {
  for (const command of ["run", "baseline"]) {
    await t.test(command, async (t) => {
      const workspace = await cliWorkspace(t);
      workspace.env.FACTORY_TEST_PI_SCENARIO = "happy";
      const taskPath = path.join(workspace.cwd, "tasks/reject-expired-session-token.json");
      const original = await readFile(taskPath, "utf8");
      const task = JSON.parse(original);
      task.verification[1].id = task.verification[0].id;
      await writeFile(taskPath, JSON.stringify(task));
      const args = command === "run" ? ["run"] : ["baseline", "--provider", "fixture", "--model", "fixture"];
      const argv = [process.execPath, "src/cli.mjs", ...args];
      const result = await runCommand(argv, workspace);
      assert.equal(result.exit_code, 1, result.stderr || result.stdout);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /duplicate.*check IDs/);
      await assert.rejects(access(path.join(workspace.cwd, ".factory-runs")), { code: "ENOENT" });
      await writeFile(taskPath, original);
      const recovered = await runCommand(argv, workspace);
      assert.equal(recovered.exit_code, 0, recovered.stderr);
      assert.equal(JSON.parse(recovered.stdout).terminal_status, "COMPLETE");
    });
  }
});

test("comparison never interprets a saved base as a Git option", async (t) => {
  const workspace = await comparisonWorkspace(t);
  const verificationPath = path.join(path.dirname(workspace.multi), "verification.json");
  const receiptBytes = await readFile(workspace.multi);
  const verificationBytes = await readFile(verificationPath);
  const receipt = JSON.parse(receiptBytes);
  const verification = JSON.parse(verificationBytes);
  const forbiddenOutput = path.join(workspace.cwd, "unexpected-git-output.patch");
  const base = `--output=${forbiddenOutput}`;
  receipt.base_sha = base;
  receipt.verified_subject.base_sha = base;
  receipt.verified_subject.patch_digest = "a".repeat(64);
  verification.base_sha = base;
  verification.patch_digest = "a".repeat(64);
  await writeFile(workspace.multi, JSON.stringify(receipt));
  await writeFile(verificationPath, JSON.stringify(verification));
  const result = await workspace.compare();
  assert.equal(result.exit_code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).graduate_to_qodo_v2, false);
  await assert.rejects(access(forbiddenOutput), { code: "ENOENT" });
  await writeFile(workspace.multi, receiptBytes);
  await writeFile(verificationPath, verificationBytes);
  const recovered = await workspace.compare();
  assert.equal(recovered.exit_code, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).graduate_to_qodo_v2, true);
});

test("comparison checks file lists against patch evidence", async (t) => {
  const workspace = await comparisonWorkspace(t);
  const verificationPath = path.join(path.dirname(workspace.multi), "verification.json");
  const receiptBytes = await readFile(workspace.multi);
  const verificationBytes = await readFile(verificationPath);
  const receipt = JSON.parse(receiptBytes);
  const verification = JSON.parse(verificationBytes);
  receipt.verified_subject.changed_files = ["tests/session.test.ts"];
  verification.changed_files = receipt.verified_subject.changed_files;
  await writeFile(workspace.multi, JSON.stringify(receipt));
  await writeFile(verificationPath, JSON.stringify(verification));
  const result = await workspace.compare();
  assert.equal(result.exit_code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).graduate_to_qodo_v2, false);
  await writeFile(workspace.multi, receiptBytes);
  await writeFile(verificationPath, verificationBytes);
  assert.equal(JSON.parse((await workspace.compare()).stdout).graduate_to_qodo_v2, true);
});

test("both runners reject files created outside the implementation during verification", async (t) => {
  for (const kind of ["workflow", "baseline"]) {
    await t.test(kind, async (t) => {
      const workspace = await cliWorkspace(t);
      const taskPath = path.join(workspace.cwd, "tasks/reject-expired-session-token.json");
      const task = JSON.parse(await readFile(taskPath, "utf8"));
      task.verification = [{ id: "generates-file", required: true, argv: [process.execPath, "-e",
        "require('node:fs').writeFileSync('generated.txt', 'verification output')"] }];
      await writeFile(taskPath, JSON.stringify(task));
      const scripted = new ScriptedRunner();
      const runner = { run: (role, context) => scripted.run(role === "baseline" ? "implementer" : role, context) };
      const options = { projectRoot: workspace.cwd, taskPath, runner };
      const result = kind === "workflow"
        ? await runPilot({ ...options, runnerName: "scripted" }) : await runBaseline(options);
      assert.equal(result.receipt.success, false);
      const verification = JSON.parse(await readFile(path.join(result.artifactsDir, "verification.json"), "utf8"));
      assert.ok(verification.changed_files.includes("generated.txt"));
      assert.match(JSON.stringify(result.receipt.gates), /out-of-scope files changed: generated.txt/);
      if (kind === "baseline") {
        assert.equal(result.receipt.gates.verification.passed, false);
        assert.match(result.receipt.gates.verification.reasons.join("\n"), /out-of-scope files changed: generated.txt/);
      } else {
        const failure = result.receipt.state_history.find((entry) => entry.event === "VERIFICATION_FAILED");
        assert.match(failure.details.reasons.join("\n"), /out-of-scope files changed: generated.txt/);
      }
      task.verification[0].argv = [process.execPath, "-e", "process.exit(0)"];
      await writeFile(taskPath, JSON.stringify(task));
      const recovered = kind === "workflow"
        ? await runPilot({ ...options, runnerName: "scripted" }) : await runBaseline(options);
      assert.equal(recovered.receipt.success, true);
    });
  }
});

test("comparison accepts verified patches containing only new files", async (t) => {
  const workspace = await cliWorkspace(t);
  const task = JSON.parse(await readFile(path.join(workspace.cwd, "tasks/reject-expired-session-token.json"), "utf8"));
  const addedFile = "tests/added.test.mjs";
  task.title = "Add a fixture test";
  task.acceptance_criteria = ["The added fixture test passes"];
  task.files_allowed = task.files_expected = task.required_test_files = [addedFile];
  task.verification = [{ id: "added-test", required: true, argv: [process.execPath, "--test", addedFile] }];
  const taskPath = path.join(workspace.cwd, "new-file-task.json");
  await writeFile(taskPath, JSON.stringify(task));
  const scripted = new ScriptedRunner();
  const runner = { run: async (role, context) => {
    const result = await scripted.run(role === "baseline" ? "implementer" : role, context);
    if (role === "planner") {
      result.output.affected_files = [addedFile];
      result.output.acceptance_criteria = task.acceptance_criteria;
    } else if (["implementer", "baseline"].includes(role)) {
      const restored = await runCommand(["git", "restore", "src/session.ts", "tests/session.test.ts"], { cwd: context.cwd });
      assert.equal(restored.exit_code, 0, restored.stderr);
      await writeFile(path.join(context.cwd, addedFile), 'import test from "node:test"; test("fixture", () => {});\n');
      result.output.changed_files = [addedFile];
    }
    return result;
  } };
  const options = { projectRoot: workspace.cwd, taskPath, runner };
  const multi = await runPilot({ ...options, runnerName: "scripted" });
  const baseline = await runBaseline(options);
  assert.equal(multi.receipt.success, true);
  assert.equal(baseline.receipt.success, true);
  assert.equal(await readFile(path.join(multi.artifactsDir, "diff.patch"), "utf8"), "");
  const acceptance = await runCommand([process.execPath, "src/cli.mjs", "acceptance"], workspace);
  assert.equal(acceptance.exit_code, 0, acceptance.stderr);
  const result = await runCommand([process.execPath, "src/compare.mjs",
    "--multi", path.join(multi.artifactsDir, "receipt.json"), "--baseline", path.join(baseline.artifactsDir, "receipt.json"),
    "--output", "comparison.json"], workspace);
  assert.equal(result.exit_code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).graduate_to_qodo_v2, true);
});
