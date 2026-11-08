import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export async function assertRegularFileWithinRoot(file, root, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedFile = path.resolve(file);
  if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} path escapes its trusted root: ${file}`);
  }

  const rootStat = await lstat(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${label} root must be a real directory, not a symlink: ${resolvedRoot}`);
  }

  const components = path.relative(resolvedRoot, resolvedFile).split(path.sep);
  let current = resolvedRoot;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const stat = await lstat(current);
    const final = index === components.length - 1;
    if (stat.isSymbolicLink()) {
      if (final) throw new Error(`${label} must be a regular file, not a symlink: ${current}`);
      throw new Error(`${label} path mustn't contain symlinks: ${current}`);
    }
    if (final && !stat.isFile()) {
      throw new Error(`${label} must be a regular file: ${current}`);
    }
    if (!final && !stat.isDirectory()) {
      throw new Error(`${label} path component must be a directory: ${current}`);
    }
  }

  const [realRoot, realFile] = await Promise.all([realpath(resolvedRoot), realpath(resolvedFile)]);
  if (!realFile.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(`${label} path escapes its trusted root: ${file}`);
  }
  return resolvedFile;
}

export async function resolveRunArtifact(runDir, relativePath, label) {
  if (!(typeof relativePath === "string" && relativePath.trim().length > 0) || path.isAbsolute(relativePath)) {
    throw new Error(`${label} artifact path must be relative to the run directory`);
  }
  const root = path.resolve(runDir);
  const resolved = path.resolve(root, relativePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} artifact path escapes the run directory: ${relativePath}`);
  }
  return assertRegularFileWithinRoot(resolved, root, `${label} artifact`);
}

