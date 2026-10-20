import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';

export type LocalProgram = { file: string; prefix: string[] };
export type ProcessStats = {
  exitCode: number | null;
  stdoutBytes: number;
  stderrBytes: number;
};
/** Internal spawn port; no CLI accepts arbitrary programs, templates or environment maps. */
export async function runAgentProcess(options: {
  program: LocalProgram;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  signal: AbortSignal;
  timeoutMs: number;
  outputPath?: string;
  cancelled?: () => boolean;
  version?: boolean;
}): Promise<ProcessStats & { versionText?: string }> {
  if (process.platform === 'win32') throw new Error('UNSUPPORTED_PLATFORM');
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 10 ||
    options.timeoutMs > 120_000
  )
    throw new Error('INVALID_CONFIG');
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.program.file,
      [...options.program.prefix, ...options.args],
      {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let versionText = '';
    let failure: string | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* Already reaped. */
        }
      }
    };
    const stop = (code: string) => {
      if (failure) return;
      failure = code;
      killGroup('SIGTERM');
      escalation = setTimeout(() => killGroup('SIGKILL'), 200);
    };
    const abort = () => stop('CANCELLED');
    options.signal.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => stop('AGENT_TIMEOUT'), options.timeoutMs);
    const monitor = setInterval(() => {
      if (options.cancelled?.()) stop('CANCELLED');
      if (options.outputPath) {
        try {
          const stat = lstatSync(options.outputPath);
          if (!stat.isFile() || stat.nlink !== 1) stop('INVALID_RESPONSE');
          else if (stat.size > 1_048_576) stop('RESPONSE_TOO_LARGE');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            stop('INVALID_RESPONSE');
        }
      }
    }, 20);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > (options.version ? 128 : 1_048_576))
        stop('RESPONSE_TOO_LARGE');
      else if (options.version) versionText += chunk.toString('utf8');
    });
    // Count and discard all stderr; no source text, paths, auth or diagnostics escape.
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 65_536) stop('RESPONSE_TOO_LARGE');
    });
    child.stdin.on('error', () => {
      /* Exit/error is authoritative; never surface a raw child error. */
    });
    child.once('error', () => {
      failure = 'AGENT_START_FAILED';
    });
    child.once('close', (code) => {
      clearTimeout(deadline);
      clearInterval(monitor);
      if (escalation) clearTimeout(escalation);
      // Descendants must not outlive a finished/failed worker, including TERM-resistant children.
      killGroup('SIGKILL');
      options.signal.removeEventListener('abort', abort);
      if (failure)
        reject(
          Object.assign(new Error(failure), {
            exitCode: code,
            stdoutBytes,
            stderrBytes,
          }),
        );
      else if (code !== 0)
        reject(
          Object.assign(new Error('AGENT_EXIT_FAILED'), {
            exitCode: code,
            stdoutBytes,
            stderrBytes,
          }),
        );
      else
        resolve({
          exitCode: code,
          stdoutBytes,
          stderrBytes,
          ...(options.version ? { versionText } : {}),
        });
    });
    if (options.signal.aborted) abort();
    child.stdin.end(options.input);
  });
}
