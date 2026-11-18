import { spawn, type ChildProcess } from "node:child_process";

const seconds = 1_000;
const cleanupTimeout = 15 * seconds;
const maxCommandOutput = 16 * 1024 * 1024;

function cleanupCommand(executable: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    const cleanup = spawn(executable, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    const deadline = setTimeout(() => {
      cleanup.kill();
      cleanup.unref();
      resolve(false);
    }, cleanupTimeout);
    function complete(succeeded: boolean) {
      clearTimeout(deadline);
      resolve(succeeded);
    }
    cleanup.once("error", () => complete(false));
    cleanup.once("exit", (status) => complete(status === 0));
  });
}

async function terminateWindows(
  child: ChildProcess,
  pid: number,
  started: number,
  ended: number,
) {
  if (
    child.exitCode === null &&
    child.signalCode === null &&
    (await cleanupCommand("taskkill.exe", ["/pid", String(pid), "/T", "/F"]))
  )
    return;
  if (child.exitCode === null && child.signalCode === null) child.kill();

  // A child can hold the pipes open after its parent exits. Limit the lookup
  // to direct children born while this command was running so reused PIDs
  // don't pick up another command's process tree.
  const script = `
$ErrorActionPreference = 'Stop'
$started = [DateTimeOffset]::FromUnixTimeMilliseconds(${started}).UtcDateTime
$ended = [DateTimeOffset]::FromUnixTimeMilliseconds(${ended}).UtcDateTime
$related = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid} OR ParentProcessId = ${pid}'
$root = $related | Where-Object ProcessId -eq ${pid}
foreach ($process in $related) {
  if ($process.ParentProcessId -ne ${pid}) { continue }
  $created = $process.CreationDate.ToUniversalTime()
  if ($created -lt $started -or $created -gt $ended) { continue }
  if ($root -and $root.CreationDate.ToUniversalTime() -le $created) { continue }
  $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($process.ProcessId)"
  if ($current -and $current.CreationDate -eq $process.CreationDate) {
    taskkill.exe /pid $process.ProcessId /T /F
  }
}
`;
  await cleanupCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]);
}

async function terminate(child: ChildProcess, started: number, ended: number) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await terminateWindows(child, child.pid, started, ended);
    return;
  }
  try {
    // The process group can outlive the process whose PID names it.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export function command(
  executable: string,
  args: string[],
  options: { timeout: number; cwd?: string; env?: NodeJS.ProcessEnv },
) {
  return new Promise<CommandResult>((resolve) => {
    const started = Date.now();
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let error: string | undefined;
    let exited: number | undefined;
    let stopping = false;
    let outputBytes = 0;
    const timer = setTimeout(() => {
      stop(`Timed out after ${options.timeout / seconds} seconds`);
    }, options.timeout);

    function stop(reason: string) {
      if (stopping) return;
      stopping = true;
      clearTimeout(timer);
      const ended = exited ?? Date.now();
      // Descendants may never release these pipes. Do not wait on "close".
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      void terminate(child, started, ended)
        .catch(() => undefined)
        .then(() => resolve({ status: null, stdout, stderr, error: reason }));
    }

    function collect(stream: "stdout" | "stderr", chunk: string) {
      if (stopping || error) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxCommandOutput) {
        stop("Command output exceeded 16 MiB");
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    }

    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => collect("stdout", chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => collect("stderr", chunk));
    child.once("error", (cause) => {
      error = cause.message;
    });
    child.once("exit", () => {
      exited = Date.now();
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      if (!stopping) resolve({ status, stdout, stderr, error });
    });
  });
}
