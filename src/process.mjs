import { spawn } from "node:child_process";

const OUTPUT_LIMIT = 256 * 1024;

function appendBounded(current, chunk) {
  const next = current + chunk;
  if (next.length <= OUTPUT_LIMIT) return next;
  return next.slice(next.length - OUTPUT_LIMIT);
}

export async function runCommand(
  argv,
  {
    cwd,
    env = process.env,
    timeoutMs = 120_000,
    onStdout = null,
    onStderr = null,
  } = {},
) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string")) {
    throw new Error("argv must be a non-empty string array");
  }

  const startedAt = new Date().toISOString();
  const started = performance.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let spawnError = null;

  const exitCode = await new Promise((resolve) => {
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = appendBounded(stdout, text);
      onStdout?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = appendBounded(stderr, text);
      onStderr?.(text);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      spawnError = error.message;
      stderr = appendBounded(stderr, error.message);
      settle(127);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle(code ?? 1);
    });
  });

  return {
    argv,
    started_at: startedAt,
    duration_ms: Math.round(performance.now() - started),
    exit_code: exitCode,
    timed_out: timedOut,
    spawn_error: spawnError,
    stdout,
    stderr,
  };
}
