import { createHash } from "node:crypto";
import { cp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { runCommand } from "./process.mjs";

async function git(cwd, args) {
  const result = await runCommand(["git", ...args], { cwd });
  if (result.exit_code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export async function initializeRepository(cwd) {
  await git(cwd, ["init", "--initial-branch=main"]);
  await git(cwd, ["config", "user.name", "Pi Mini Factory"]);
  await git(cwd, ["config", "user.email", "pi-mini-factory@example.invalid"]);
  await git(cwd, ["add", "--all"]);
  await git(cwd, ["commit", "-m", "fixture: vulnerable baseline"]);
  return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

export async function prepareTaskRepository({ projectRoot, task, destination }) {
  if (task.fixture) {
    await cp(path.resolve(projectRoot, task.fixture), destination, { recursive: true });
    return initializeRepository(destination);
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const clone = await runCommand(
    [
      "git",
      "clone",
      "--branch",
      task.repository.clone_ref,
      "--single-branch",
      task.repository.url,
      destination,
    ],
    { timeoutMs: 180_000 },
  );
  if (clone.exit_code !== 0) {
    throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`);
  }
  await git(destination, ["config", "user.name", "Pi Mini Factory"]);
  await git(destination, ["config", "user.email", "pi-mini-factory@example.invalid"]);
  const baseSha = (
    await git(destination, ["rev-parse", "--verify", `${task.repository.base_ref}^{commit}`])
  ).trim();
  const branchSuffix = task.id.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
  await git(destination, ["switch", "-c", `mini-factory/${branchSuffix}`, baseSha]);
  return baseSha;
}

export async function changedFiles(cwd, baseSha) {
  const tracked = (await git(cwd, ["diff", "--name-only", "--no-ext-diff", baseSha, "--"]))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

export async function patchEvidence(cwd, baseSha) {
  const trackedPatch = await git(cwd, ["diff", "--binary", "--no-ext-diff", baseSha, "--"]);
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
    .sort();

  const untrackedParts = [];
  for (const file of untracked) {
    const contents = await readFile(path.join(cwd, file));
    untrackedParts.push(`\nUNTRACKED ${file}\n${contents.toString("base64")}\n`);
  }

  const canonicalPatch = `${trackedPatch}${untrackedParts.join("")}`;
  return {
    patch: trackedPatch,
    digest: createHash("sha256").update(canonicalPatch).digest("hex"),
    untracked_files: untracked,
  };
}
