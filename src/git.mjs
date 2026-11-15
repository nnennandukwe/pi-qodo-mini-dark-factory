import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

import { assertRegularFileWithinRoot } from "./artifacts.mjs";
import { assertCompleteOutput, IncompleteProcessEvidenceError, runCommand } from "./process.mjs";

async function git(cwd, args) {
  const result = await runCommand(["git", ...args], { cwd });
  assertCompleteOutput(result, `git ${args[0]}`);
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
  assertCompleteOutput(clone, "git clone");
  if (clone.exit_code !== 0) {
    throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`);
  }
  await git(destination, ["config", "user.name", "Pi Mini Factory"]);
  await git(destination, ["config", "user.email", "pi-mini-factory@example.invalid"]);
  const baseSha = (
    await git(destination, ["rev-parse", "--verify", `${task.repository.base_ref}^{commit}`])
  ).trim();
  if (task.repository.expected_base_sha && baseSha !== task.repository.expected_base_sha) {
    throw new Error(
      `repository base ${baseSha} does not match expected_base_sha ${task.repository.expected_base_sha}`,
    );
  }
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

async function readUntrackedFile(repoDir, relativePath) {
  const file = path.join(repoDir, relativePath);
  let handle;
  try {
    await assertRegularFileWithinRoot(file, repoDir, "untracked file");
    const expected = await lstat(file, { bigint: true });
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || expected.dev !== opened.dev || expected.ino !== opened.ino) {
      throw new Error("The untracked file changed during inspection.");
    }
    await assertRegularFileWithinRoot(file, repoDir, "untracked file");
    return await handle.readFile();
  } catch (error) {
    throw new IncompleteProcessEvidenceError(`Can't verify untracked file ${relativePath}: ${error.message}. Restore a regular file and retry.`, { cause: error });
  } finally {
    await handle?.close();
  }
}

export async function patchEvidence(cwd, baseSha) {
  const trackedPatch = await git(cwd, ["diff", "--binary", "--no-ext-diff", baseSha, "--"]);
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean)
    .sort();

  const untrackedParts = [];
  for (const file of untracked) {
    const contents = await readUntrackedFile(cwd, file);
    untrackedParts.push(`\nUNTRACKED ${file}\n${contents.toString("base64")}\n`);
  }

  const canonicalPatch = `${trackedPatch}${untrackedParts.join("")}`;
  return {
    patch: trackedPatch,
    digest: createHash("sha256").update(canonicalPatch).digest("hex"),
    untracked_files: untracked,
  };
}
