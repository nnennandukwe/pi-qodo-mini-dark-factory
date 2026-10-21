import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-dx-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function executable(directory, name, source) {
  const target = path.join(directory, name);
  await writeFile(target, `#!${process.execPath}\n${source}\n`, { mode: 0o755 });
  return target;
}

export async function cliWorkspace(t) {
  const directory = await temporaryDirectory(t);
  for (const name of ["src", "tasks", "fixtures", "oracles", "roles", "package.json"]) {
    await cp(path.join(projectRoot, name), path.join(directory, name), { recursive: true });
  }
  await symlink(path.join(projectRoot, "node_modules"), path.join(directory, "node_modules"), "dir");
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await executable(bin, "pi", `
import { ScriptedRunner } from "../src/scripted-runner.mjs";
import path from "node:path";
if (process.argv.includes("--version")) {
  console.log("fixture-pi");
} else if (process.env.FACTORY_TEST_PI_SCENARIO) {
  const runner = new ScriptedRunner({ scenario: process.env.FACTORY_TEST_PI_SCENARIO });
  const promptIndex = process.argv.indexOf("--append-system-prompt") + 1;
  const role = path.basename(process.argv[promptIndex], ".md");
  const { output } = await runner.run(role === "baseline" ? "implementer" : role, { cwd: process.cwd() });
  if (process.env.FACTORY_TEST_PI_SCENARIO === "oversized-review" && role === "reviewer") {
    console.log(JSON.stringify({ type: "message_update", padding: "x".repeat(300000) }));
  }
  console.log(JSON.stringify({ type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text: JSON.stringify(output) }],
    usage: { input: 10, output: 20, cost: { total: 0.01 } }, stopReason: "stop"
  } }));
} else {
  process.exit(9);
}
`);
  return {
    cwd: directory,
    env: { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` },
  };
}
