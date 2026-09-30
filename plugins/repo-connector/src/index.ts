import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, join, relative, sep } from 'node:path';
import type {
  ConnectorInput,
  ConnectorOutput,
  SourceFile,
} from '@opencontext/contracts';
import type { ExecutionContext, OfficialPlugin } from '@opencontext/plugin-sdk';

const MAX_SINGLE_FILE_BYTES = 1_048_576;
const MAX_TREE_BYTES = 8_388_608;
const DEADLINE_MS = 30_000;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
// Preserve a UTF-8 BOM in the returned string so re-encoding yields exact bytes.
const decode = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export class RepoConnectorError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.name = 'RepoConnectorError';
  }
}

// An explicit environment prevents inheriting tokens, askpass helpers, SSH agents,
// Git config injection, proxy credentials or a user's credential-helper setup.
// This is process hygiene, not an OS or network sandbox.
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/bin/false',
    SSH_ASKPASS: '/bin/false',
    GCM_INTERACTIVE: 'Never',
    GIT_LFS_SKIP_SMUDGE: '1',
  };
}

function fixedGitArgs(local: boolean): string[] {
  return [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'credential.helper=',
    '-c',
    'credential.interactive=false',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.https.allow=always',
    '-c',
    `protocol.file.allow=${local ? 'always' : 'never'}`,
    '-c',
    'http.followRedirects=false',
    '-c',
    'fetch.recurseSubmodules=false',
  ];
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new RepoConnectorError('CANCELLED', 'Git snapshot cancelled');
}

async function git(
  args: string[],
  cwd: string,
  context: ExecutionContext,
  deadline: number,
  local: boolean,
  maxOutput = MAX_TREE_BYTES,
): Promise<Buffer> {
  aborted(context.signal);
  const remaining = deadline - Date.now();
  if (remaining <= 0)
    throw new RepoConnectorError(
      'TIMEOUT',
      'Git snapshot exceeded its time budget',
    );
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', [...fixedGitArgs(local), ...args], {
      cwd,
      shell: false,
      env: gitEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const output: Buffer[] = [];
    let bytes = 0;
    let failure: RepoConnectorError | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* The process may have exited between the close/abort events. */
      }
    };
    const stop = (error: RepoConnectorError): void => {
      if (failure) return;
      failure = error;
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 250);
      killTimer.unref();
    };
    const onAbort = (): void =>
      stop(new RepoConnectorError('CANCELLED', 'Git snapshot cancelled'));
    const timer = setTimeout(
      () =>
        stop(
          new RepoConnectorError(
            'TIMEOUT',
            'Git snapshot exceeded its time budget',
          ),
        ),
      remaining,
    );
    context.signal.addEventListener('abort', onAbort, { once: true });
    // Close the small gap between the pre-spawn check and listener attachment.
    if (context.signal.aborted) onAbort();
    const receive = (chunk: Buffer, stdout: boolean): void => {
      bytes += chunk.byteLength;
      if (bytes > maxOutput)
        stop(
          new RepoConnectorError(
            'OUTPUT_LIMIT',
            'Git command output exceeded its limit',
          ),
        );
      else if (stdout) output.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => receive(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => receive(chunk, false));
    child.on('error', () => {
      failure ??= new RepoConnectorError(
        'GIT_UNAVAILABLE',
        'Could not start Git',
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      context.signal.removeEventListener('abort', onAbort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new RepoConnectorError(
            'GIT_FAILED',
            `Git ${args[0] ?? 'command'} failed`,
          ),
        );
      else resolve(Buffer.concat(output));
    });
  });
}

export async function resolveSource(
  repoUrl: string,
  allowedRoot?: string,
): Promise<{ source: string; local: boolean }> {
  if (!repoUrl || repoUrl.startsWith('-') || hasControlCharacters(repoUrl)) {
    throw new RepoConnectorError('INVALID_SOURCE', 'Unsafe repository URL');
  }
  if (isAbsolute(repoUrl)) {
    if (!allowedRoot)
      throw new RepoConnectorError(
        'LOCAL_SOURCE_DENIED',
        'Local Git paths are allowed only by an explicit test root',
      );
    const [root, source] = await Promise.all([
      realpath(allowedRoot),
      realpath(repoUrl),
    ]);
    const rel = relative(root, source);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new RepoConnectorError(
        'LOCAL_SOURCE_DENIED',
        'Repository resolves outside the permitted local root',
      );
    }
    return { source, local: true };
  }
  let url: URL;
  try {
    url = new URL(repoUrl);
  } catch {
    throw new RepoConnectorError(
      'INVALID_SOURCE',
      'Use an HTTPS repository URL',
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new RepoConnectorError(
      'INVALID_SOURCE',
      'Only HTTPS URLs without credentials, query or fragment are supported',
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // No raw IPs or local hostnames. A production egress policy must additionally
  // protect against private DNS answers/rebinding; trusted-native is not SSRF isolation.
  if (
    isIP(host) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    !host.includes('.')
  ) {
    throw new RepoConnectorError(
      'INVALID_SOURCE',
      'A public HTTPS hostname is required',
    );
  }
  return { source: url.href, local: false };
}

function safePath(path: string): boolean {
  return (
    Boolean(path) &&
    path === path.normalize('NFC') &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !hasControlCharacters(path) &&
    path
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

type TreeEntry = {
  path: string;
  mode: string;
  type: string;
  hash: string;
  bytes: number;
};

function parseTree(data: Buffer): TreeEntry[] {
  let text: string;
  try {
    text = decode.decode(data);
  } catch {
    throw new RepoConnectorError(
      'UNSUPPORTED_PATH',
      'Repository contains a non-UTF-8 path',
    );
  }
  return text
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match =
        /^(\d{6}) (blob|commit) ([a-f0-9]+) +([0-9]+|-)\t([\s\S]+)$/.exec(
          entry,
        );
      if (
        !match?.[1] ||
        !match[2] ||
        !match[3] ||
        !match[4] ||
        !match[5] ||
        !safePath(match[5])
      ) {
        throw new RepoConnectorError(
          'UNSUPPORTED_PATH',
          'Repository tree contains an unsafe or unsupported entry',
        );
      }
      return {
        mode: match[1],
        type: match[2],
        hash: match[3],
        bytes: match[4] === '-' ? 0 : Number(match[4]),
        path: match[5],
      };
    });
}

function parseRenames(
  data: Buffer,
  included: Set<string>,
): { from: string; to: string }[] {
  const tokens = decode.decode(data).split('\0').filter(Boolean);
  const renames: { from: string; to: string }[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (!status) continue;
    if (/^[RC]\d+$/.test(status)) {
      const from = tokens[++index];
      const to = tokens[++index];
      if (
        status.startsWith('R') &&
        from &&
        to &&
        safePath(from) &&
        safePath(to) &&
        included.has(to)
      )
        renames.push({ from, to });
    } else index += 1;
  }
  return renames;
}

export const repoConnector: OfficialPlugin<ConnectorInput, ConnectorOutput> = {
  manifest: {
    id: 'org.opencontext.repo',
    version: '0.1.0',
    protocolVersion: '1',
    capabilities: ['connector'],
    location: 'server',
    trust: 'official-trusted-native',
  },
  probe() {
    const result = spawnSync('git', ['--version'], {
      shell: false,
      env: gitEnvironment(),
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 65_536,
    });
    return {
      available: result.status === 0,
      capabilities: ['connector'],
      limitations: [
        'Public HTTPS only; explicit local root is for synthetic tests.',
        'Trusted native Git process; no OS/network sandbox or private DNS isolation.',
        'No submodules, Git LFS content, symlinks, binary/non-UTF-8 files, or files above 1 MiB.',
        'Fetch has a time/output budget, but packfile disk usage requires an external volume quota.',
      ],
    };
  },
  async invoke(input, context) {
    aborted(context.signal);
    if (
      !Number.isSafeInteger(input.maxFiles) ||
      input.maxFiles < 1 ||
      input.maxFiles > 10_000 ||
      !Number.isSafeInteger(input.maxBytes) ||
      input.maxBytes < 1 ||
      input.maxBytes > 104_857_600 ||
      !input.branch ||
      input.branch.length > 200 ||
      (input.previousVersion !== null && !SHA.test(input.previousVersion))
    ) {
      throw new RepoConnectorError(
        'INVALID_CONFIG',
        'Invalid branch, previous SHA or snapshot limits',
      );
    }
    const { source, local } = await resolveSource(
      input.repoUrl,
      context.allowedLocalRepoRoot,
    );
    await mkdir(context.workDir, { recursive: true });
    const scratch = await mkdtemp(join(context.workDir, 'repo-sync-'));
    const deadline = Date.now() + DEADLINE_MS;
    const run = (args: string[], maxOutput?: number): Promise<Buffer> =>
      git(args, scratch, context, deadline, local, maxOutput);
    try {
      await mkdir(join(scratch, 'empty-template'));
      await run(['init', '--bare', '--template=empty-template', 'objects.git']);
      const db = join(scratch, 'objects.git');
      const repo = (args: string[], maxOutput?: number): Promise<Buffer> =>
        run([`--git-dir=${db}`, ...args], maxOutput);
      try {
        await run(['check-ref-format', `refs/heads/${input.branch}`]);
      } catch (error) {
        if (error instanceof RepoConnectorError && error.code === 'GIT_FAILED')
          throw new RepoConnectorError('INVALID_BRANCH', 'Invalid branch name');
        throw error;
      }
      await repo([
        'fetch',
        '--depth=1',
        '--no-tags',
        '--no-recurse-submodules',
        '--force',
        '--',
        source,
        `refs/heads/${input.branch}`,
      ]);
      const sourceVersion = (
        await repo(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
      )
        .toString('utf8')
        .trim();
      if (!SHA.test(sourceVersion))
        throw new RepoConnectorError(
          'INVALID_SNAPSHOT',
          'Git did not return a valid commit SHA',
        );
      const entries = parseTree(
        await repo(['ls-tree', '-r', '-l', '-z', sourceVersion]),
      );
      if (entries.length > input.maxFiles)
        throw new RepoConnectorError(
          'FILE_LIMIT',
          'Repository tree exceeds the configured file limit',
        );
      const files: SourceFile[] = [];
      const skipped: ConnectorOutput['skipped'] = [];
      let bytes = 0;
      for (const entry of entries) {
        aborted(context.signal);
        let reason: string | undefined;
        if (entry.type !== 'blob' || entry.mode === '160000')
          reason = 'submodule';
        else if (entry.mode === '120000') reason = 'symlink';
        else if (entry.bytes > MAX_SINGLE_FILE_BYTES)
          reason = 'file_above_1_mib';
        if (reason) {
          skipped.push({ path: entry.path, reason });
          continue;
        }
        const content = await repo(
          ['cat-file', 'blob', entry.hash],
          MAX_SINGLE_FILE_BYTES + 65_536,
        );
        if (content.length !== entry.bytes)
          throw new RepoConnectorError(
            'INVALID_SNAPSHOT',
            'Git blob length differs from its tree entry',
          );
        let text: string;
        try {
          text = decode.decode(content);
        } catch {
          skipped.push({ path: entry.path, reason: 'non_utf8' });
          continue;
        }
        if (content.includes(0)) {
          skipped.push({ path: entry.path, reason: 'binary' });
          continue;
        }
        if (/^version https:\/\/git-lfs.github.com\/spec\/v1\r?\n/.test(text)) {
          skipped.push({ path: entry.path, reason: 'lfs_pointer' });
          continue;
        }
        bytes += content.length;
        if (bytes > input.maxBytes)
          throw new RepoConnectorError(
            'BYTE_LIMIT',
            'Supported text snapshot exceeds the configured byte limit',
          );
        files.push({
          relativePath: entry.path,
          content: text,
          mime: /\.md$/i.test(entry.path) ? 'text/markdown' : 'text/plain',
        });
      }
      let renames: ConnectorOutput['renames'] = [];
      if (input.previousVersion && input.previousVersion !== sourceVersion) {
        let previousAvailable = true;
        try {
          await repo([
            'fetch',
            '--depth=1',
            '--no-tags',
            '--no-recurse-submodules',
            '--',
            source,
            input.previousVersion,
          ]);
        } catch (error) {
          // A force-push or server policy can make the previous SHA unavailable.
          // The already-read full snapshot is still authoritative; don't guess identity.
          if (
            error instanceof RepoConnectorError &&
            error.code === 'GIT_FAILED'
          )
            previousAvailable = false;
          else throw error;
        }
        if (previousAvailable)
          renames = parseRenames(
            await repo([
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              '--name-status',
              '-z',
              '--find-renames',
              input.previousVersion,
              sourceVersion,
              '--',
            ]),
            new Set(files.map((file) => file.relativePath)),
          );
      }
      aborted(context.signal);
      // complete means every tree entry was visited under the explicit supported
      // text policy. Failures/limits throw; unsupported entries are never hidden.
      return { sourceVersion, complete: true, files, renames, skipped };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
};
