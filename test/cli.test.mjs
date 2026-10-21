import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCommand } from "../src/process.mjs";
import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { cliWorkspace } from "./helpers/workspace.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("CLI rejects a misspelled safety-sensitive option", async () => {
  const result = await runCommand(
    [process.execPath, "src/cli.mjs", "retry-review", "--qodo-dept", "deep"],
    { cwd: root },
  );
  assert.equal(result.exit_code, 1);
  assert.match(result.stderr, /Unknown option for retry-review: --qodo-dept/);
});

test("CLI help documents review retry and recovery input", async () => {
  const result = await runCommand([process.execPath, "src/cli.mjs", "--help"], { cwd: root });
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /retry-review --run-dir/);
  assert.match(result.stdout, /--attempt-id/);
});

test("every command accepts help before required options without creating runs", async (t) => {
  const workspace = await cliWorkspace(t);
  for (const command of ["acceptance", "baseline", "benchmark", "run", "retry-review"]) {
    for (const flag of ["--help", "-h"]) {
      const result = await runCommand([process.execPath, "src/cli.mjs", command, flag], workspace);
      assert.equal(result.exit_code, 0, result.stderr);
      assert.match(result.stdout, /Usage:/);
      assert.equal(result.stderr, "");
    }
  }
  await assert.rejects(access(path.join(workspace.cwd, ".factory-runs")), { code: "ENOENT" });
});

test("scripted CLI exits follow the receipt after real controller gates", async (t) => {
  const workspace = await cliWorkspace(t);
  for (const [scenario, status, exit] of [
    ["happy", "COMPLETE", 0],
    ["plan-missing-non-goals", "PLAN_REJECTED", 1],
    ["verification-fail", "VERIFICATION_FAILED", 1],
    ["review-changes", "CHANGES_REQUESTED", 1],
  ]) {
    await t.test(scenario, async () => {
      const result = await runCommand(
        [process.execPath, "src/cli.mjs", "run", "--runner", "scripted", "--scenario", scenario],
        workspace,
      );
      const summary = JSON.parse(result.stdout);
      const receipt = JSON.parse(await readFile(summary.receipt, "utf8"));
      assert.equal(receipt.terminal_status, status, result.stderr);
      assert.equal(summary.success, exit === 0);
      assert.equal(result.exit_code, exit, `receipt says ${status}, but process exited ${result.exit_code}`);
    });
  }
});

test("baseline agent failure exits nonzero after writing its receipt", async (t) => {
  const workspace = await cliWorkspace(t);
  const result = await runCommand(
    [process.execPath, "src/cli.mjs", "baseline", "--provider", "fixture", "--model", "fixture"],
    workspace,
  );
  const summary = JSON.parse(result.stdout);
  const receipt = JSON.parse(await readFile(summary.receipt, "utf8"));
  assert.equal(receipt.terminal_status, "AGENT_FAILED");
  assert.equal(summary.success, false);
  assert.equal(result.exit_code, 1);
});

test("baseline exits reflect actual verification results", async (t) => {
  const workspace = await cliWorkspace(t);
  for (const [scenario, status, exit] of [["happy", "COMPLETE", 0], ["verification-fail", "FAILED", 1]]) {
    const result = await runCommand(
      [process.execPath, "src/cli.mjs", "baseline", "--provider", "fixture", "--model", "fixture"],
      { ...workspace, env: { ...workspace.env, FACTORY_TEST_PI_SCENARIO: scenario } },
    );
    const summary = JSON.parse(result.stdout);
    const receipt = JSON.parse(await readFile(summary.receipt, "utf8"));
    assert.equal(receipt.terminal_status, status, result.stderr);
    assert.equal(summary.success, exit === 0);
    assert.equal(result.exit_code, exit);
  }
});

test("acceptance succeeds when all planted failures reach their expected gates", async (t) => {
  const workspace = await cliWorkspace(t);
  const result = await runCommand([process.execPath, "src/cli.mjs", "acceptance"], workspace);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.scenarios.length, 7);
  assert.equal(summary.passed, true, result.stderr);
  assert.equal(result.exit_code, 0);
});

test("oversized review leaves usage unknown in the receipt and comparison", async (t) => {
  const workspace = await cliWorkspace(t);
  const baseline = await runCommand(
    [process.execPath, "src/cli.mjs", "baseline", "--provider", "fixture", "--model", "fixture"],
    { ...workspace, env: { ...workspace.env, FACTORY_TEST_PI_SCENARIO: "happy" } },
  );
  assert.equal(baseline.exit_code, 0, baseline.stderr);
  const baselinePath = JSON.parse(baseline.stdout).receipt;
  await mkdir(path.join(workspace.cwd, "evidence/v1"), { recursive: true });
  await writeFile(path.join(workspace.cwd, "evidence/v1/scripted-acceptance.json"), JSON.stringify({ passed: true }));
  for (const [scenario, status, exit] of [["oversized-review", "REVIEWER_FAILED", 1], ["happy", "COMPLETE", 0]]) {
    const result = await runCommand(
      [process.execPath, "src/cli.mjs", "run", "--runner", "pi", "--provider", "fixture", "--model", "fixture"],
      { ...workspace, env: { ...workspace.env, FACTORY_TEST_PI_SCENARIO: scenario } },
    );
    assert.equal(result.exit_code, exit, result.stderr);
    const summary = JSON.parse(result.stdout);
    const receipt = JSON.parse(await readFile(summary.receipt, "utf8"));
    assert.equal(receipt.terminal_status, status);
    assert.equal(receipt.usage_complete, exit === 0);
    if (exit) {
      assert.equal(receipt.usage, null);
      assert.match(receipt.gates.find((gate) => gate.name === "reviewer_runtime").reasons[0], /capture limit/);
    }
    const output = path.join(workspace.cwd, `${scenario}-comparison.json`);
    const comparisonCommand = await runCommand(
      [process.execPath, "src/compare.mjs", "--multi", summary.receipt, "--baseline", baselinePath, "--output", output],
      workspace,
    );
    assert.equal(comparisonCommand.exit_code, 0, comparisonCommand.stderr);
    const comparison = JSON.parse(await readFile(output, "utf8"));
    assert.equal(comparison.multi_agent.usage_complete, exit === 0);
    if (exit) {
      assert.equal(comparison.multi_agent.cost_usd, null);
      assert.equal(comparison.multi_agent.input_tokens, null);
      assert.equal(comparison.overhead.cost_percent, null);
      assert.equal(comparison.overhead.input_tokens_percent, null);
    } else {
      assert.equal(comparison.multi_agent.input_tokens, 30);
      assert.equal(comparison.overhead.input_tokens_percent, 200);
    }
  }
});


test("CLI help documents the benchmark and resume path", async () => {
  const result = await runCommand([process.execPath, "src/cli.mjs", "--help"], { cwd: root });
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /benchmark --provider/);
  assert.match(result.stdout, /--resume/);
});

test("comparison help and invalid input use the expected streams without stack traces", async () => {
  for (const [args, exit] of [[["--help"], 0], [[], 1], [["--multi"], 1], [["--unknown", "path"], 1]]) {
    const result = await runCommand([process.execPath, "src/compare.mjs", ...args], { cwd: root });
    assert.equal(result.exit_code, exit);
    assert.doesNotMatch(result.stderr, /\n\s+at |file:\/\//);
    assert.match(exit === 0 ? result.stdout : result.stderr, /Usage:|usage/);
    assert.equal(exit === 0 ? result.stderr : result.stdout, "");
  }
});

test("quiet suppresses summaries while preserving failure exit codes", async (t) => {
  const workspace = await cliWorkspace(t);
  for (const [scenario, exit] of [["happy", 0], ["plan-missing-non-goals", 1]]) {
    const result = await runCommand([process.execPath, "src/cli.mjs", "run", "--scenario", scenario, "--quiet"], workspace);
    assert.equal(result.exit_code, exit, result.stderr);
    assert.equal(result.stdout, "");
  }
  const invalid = await runCommand([process.execPath, "src/cli.mjs", "run", "--quiet", "false"], workspace);
  assert.equal(invalid.exit_code, 1);
  assert.match(invalid.stderr, /Unexpected argument: false/);
});

test("scripted acceptance succeeds with Pi absent from PATH", async (t) => {
  const workspace = await cliWorkspace(t);
  const cleanBin = path.join(workspace.cwd, "without-pi");
  await mkdir(cleanBin);
  await symlink(process.execPath, path.join(cleanBin, "node"));
  await symlink(path.join(path.dirname(process.execPath), "npm"), path.join(cleanBin, "npm"));
  const env = { ...workspace.env, PATH: `${cleanBin}:/usr/bin:/bin` };
  const piProbe = await runCommand(["pi", "--version"], { env });
  assert.equal(piProbe.exit_code, 127);
  const result = await runCommand([process.execPath, "src/cli.mjs", "acceptance"], { ...workspace, env });
  assert.equal(result.exit_code, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.passed, true);
  assert.equal(summary.scenarios.length, 7);
  assert.equal(summary.pi_version, null);
});

test("comparison rejects saved timeout evidence even when child and receipts claim success", async (t) => {
  const workspace = await cliWorkspace(t);
  const multiResult = await runCommand([process.execPath, "src/cli.mjs", "run", "--scenario", "happy"], workspace);
  const baselineResult = await runCommand([process.execPath, "src/cli.mjs", "baseline", "--provider", "fixture", "--model", "fixture"], {
    ...workspace, env: { ...workspace.env, FACTORY_TEST_PI_SCENARIO: "happy" },
  });
  assert.equal(multiResult.exit_code, 0, multiResult.stderr);
  assert.equal(baselineResult.exit_code, 0, baselineResult.stderr);
  const multiPath = JSON.parse(multiResult.stdout).receipt;
  const baselinePath = JSON.parse(baselineResult.stdout).receipt;
  await mkdir(path.join(workspace.cwd, "evidence/v1"), { recursive: true });
  await writeFile(path.join(workspace.cwd, "evidence/v1/scripted-acceptance.json"), JSON.stringify({ passed: true }));
  const verificationPath = path.join(path.dirname(multiPath), "verification.json");
  const original = await readFile(verificationPath, "utf8");
  for (const timedOut of [false, true]) {
    const verification = JSON.parse(original);
    verification.checks[0].exit_code = 0;
    verification.checks[0].timed_out = timedOut;
    await writeFile(verificationPath, JSON.stringify(verification));
    const output = path.join(workspace.cwd, `comparison-${timedOut}.json`);
    const result = await runCommand([process.execPath, "src/compare.mjs", "--multi", multiPath, "--baseline", baselinePath, "--output", output], workspace);
    assert.equal(result.exit_code, 0, result.stderr);
    const comparison = JSON.parse(await readFile(output, "utf8"));
    assert.equal(comparison.multi_agent.required_checks_passed, !timedOut);
    assert.equal(comparison.graduation.graduate_to_qodo_v2, !timedOut);
  }
});
