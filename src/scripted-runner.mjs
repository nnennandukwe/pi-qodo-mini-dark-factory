import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const VALID_PLAN = Object.freeze({
  task_id: "reject-expired-session-token",
  summary: "Add an explicit expiration check and cover both expired and valid renewal behavior.",
  acceptance_criteria: [
    "Expired tokens return status 401 with the existing response schema",
    "Valid tokens still renew successfully",
  ],
  affected_files: ["src/session.ts", "tests/session.test.ts"],
  steps: [
    "Add the missing expiration guard before issuing a renewed token",
    "Add a regression test for an expired token",
    "Run every declared verification command",
  ],
  risks: ["Boundary semantics at exactly expiresAt must remain explicit"],
  non_goals: ["No token-library upgrade", "No response-schema changes"],
});

async function applyHappyPatch(cwd) {
  const sourcePath = path.join(cwd, "src", "session.ts");
  const testPath = path.join(cwd, "tests", "session.test.ts");
  const source = await readFile(sourcePath, "utf8");
  const test = await readFile(testPath, "utf8");
  await writeFile(
    sourcePath,
    source.replace(
      '  if (!token.subject) {\n    return { status: 401, body: { error: "invalid_token" } };\n  }\n',
      '  if (!token.subject || token.expiresAt <= nowEpochSeconds) {\n    return { status: 401, body: { error: "invalid_token" } };\n  }\n',
    ),
  );
  await writeFile(
    testPath,
    `${test}\ntest("rejects an expired token", () => {\n  assert.deepEqual(\n    renewSession({ subject: "user-123", expiresAt: 1_700_000_000 }, 1_700_000_001),\n    { status: 401, body: { error: "invalid_token" } },\n  );\n});\n`,
  );
}

async function applyFailingPatch(cwd) {
  const testPath = path.join(cwd, "tests", "session.test.ts");
  const test = await readFile(testPath, "utf8");
  await writeFile(
    testPath,
    `${test}\ntest("rejects an expired token", () => {\n  assert.equal(\n    renewSession({ subject: "user-123", expiresAt: 1_700_000_000 }, 1_700_000_001).status,\n    401,\n  );\n});\n`,
  );
}

function implementationReport(changedFiles) {
  return {
    task_id: "reject-expired-session-token",
    summary: "Added expiration coverage and the smallest session-renewal change for the scenario.",
    changed_files: changedFiles,
    commands_run: ["npm test"],
    assumptions: ["expiresAt and nowEpochSeconds use the same epoch-second unit"],
    unresolved_risks: [],
  };
}

export class ScriptedRunner {
  constructor({ scenario = "happy" } = {}) {
    this.scenario = scenario;
  }

  async run(role, { cwd }) {
    const started = performance.now();
    let output;
    if (role === "planner") {
      output = structuredClone(VALID_PLAN);
      if (this.scenario === "plan-missing-non-goals") output.non_goals = [];
    } else if (role === "implementer") {
      if (this.scenario === "verification-fail") {
        await applyFailingPatch(cwd);
        output = implementationReport(["tests/session.test.ts"]);
      } else {
        await applyHappyPatch(cwd);
        const changedFiles = ["src/session.ts", "tests/session.test.ts"];
        if (this.scenario === "out-of-scope") {
          await writeFile(path.join(cwd, "unexpected-notes.txt"), "This file is outside the approved plan.\n");
          changedFiles.push("unexpected-notes.txt");
        }
        output = implementationReport(changedFiles);
      }
    } else if (role === "reviewer") {
      if (this.scenario === "review-time-mutation") {
        const sourcePath = path.join(cwd, "src", "session.ts");
        const source = await readFile(sourcePath, "utf8");
        await writeFile(sourcePath, `${source}\n// mutation during review\n`);
        throw new Error("scripted reviewer failed after mutating the patch");
      }
      output = {
        task_id: "reject-expired-session-token",
        decision: this.scenario === "review-changes" ? "request_changes" : "approve",
        evidence_sufficient: true,
        findings:
          this.scenario === "review-changes"
            ? [
                {
                  severity: "medium",
                  file: "tests/session.test.ts",
                  summary: "Add an exact-boundary test for expiresAt equal to now.",
                },
              ]
            : [],
        skipped_checks: [],
      };
    } else {
      throw new Error(`Unknown scripted role: ${role}`);
    }

    return {
      output,
      evidence: {
        role,
        scripted: true,
        scenario: this.scenario,
        duration_ms: Math.round(performance.now() - started),
        usage: { input: 0, output: 0, cost_usd: 0, turns: 0 },
      },
    };
  }

  async afterVerification({ cwd }) {
    if (this.scenario !== "post-verification-mutation") return;
    const sourcePath = path.join(cwd, "src", "session.ts");
    const source = await readFile(sourcePath, "utf8");
    await writeFile(sourcePath, `${source}\n// mutation after verification\n`);
  }
}
