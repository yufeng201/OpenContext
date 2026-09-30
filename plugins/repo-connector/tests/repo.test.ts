import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { ConnectorInput } from '@opencontext/contracts';
import { repoConnector } from '../src/index.ts';

const temporaryRoots: string[] = [];

function fixtureGit(cwd: string, args: string[]): string {
  const result = spawnSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'user.name=Synthetic Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      ...args,
    ],
    {
      cwd,
      shell: false,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    },
  );
  if (result.status !== 0)
    throw new Error(
      `Synthetic Git fixture failed: ${args[0] ?? ''}; ${result.stderr}`,
    );
  return result.stdout.trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'opencontext-git-fixture-'));
  temporaryRoots.push(root);
  const work = join(root, 'work');
  const bare = join(root, 'fixture.git');
  const scratch = join(root, 'scratch');
  await mkdir(work);
  await mkdir(scratch);
  fixtureGit(work, ['init', '--initial-branch=main', '--template=']);
  await writeFile(
    join(work, 'README.md'),
    '# Synthetic repo\nUnique source evidence.\n',
  );
  await writeFile(
    join(work, 'remove.txt'),
    'Remove this synthetic file later.\n',
  );
  fixtureGit(work, ['add', '--all']);
  fixtureGit(work, ['commit', '-m', 'Synthetic initial state']);
  fixtureGit(root, ['clone', '--bare', '--template=', work, bare]);
  const input: ConnectorInput = {
    repoUrl: bare,
    branch: 'main',
    previousVersion: null,
    maxFiles: 100,
    maxBytes: 4_194_304,
  };
  const context = {
    signal: new AbortController().signal,
    workDir: scratch,
    allowedLocalRepoRoot: root,
  };
  return {
    root,
    work,
    bare,
    scratch,
    input,
    context,
    update() {
      fixtureGit(work, ['add', '--all']);
      fixtureGit(work, ['commit', '-m', 'Synthetic next state']);
      fixtureGit(bare, [
        'fetch',
        '--no-tags',
        work,
        '+refs/heads/main:refs/heads/main',
      ]);
    },
  };
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('official Git connector using only synthetic local repositories', () => {
  test('probes Git and reads a fixed complete snapshot; repeats deterministically', async () => {
    const f = await fixture();
    expect(repoConnector.probe().available).toBe(true);
    expect(repoConnector.manifest.capabilities).toEqual(['connector']);
    const first = await repoConnector.invoke(f.input, f.context);
    expect(first.complete).toBe(true);
    expect(first.sourceVersion).toBe(fixtureGit(f.work, ['rev-parse', 'HEAD']));
    expect(first.files.map((file) => file.relativePath)).toEqual([
      'README.md',
      'remove.txt',
    ]);
    const second = await repoConnector.invoke(
      { ...f.input, previousVersion: first.sourceVersion },
      f.context,
    );
    expect(second).toEqual(first);
    expect(await readdir(f.scratch)).toEqual([]);
  });

  test('enumerates add/modify/delete and identifies a rename against the previous SHA', async () => {
    const f = await fixture();
    const first = await repoConnector.invoke(f.input, f.context);
    fixtureGit(f.work, ['mv', 'README.md', 'renamed.md']);
    fixtureGit(f.work, ['rm', 'remove.txt']);
    await writeFile(join(f.work, 'added.txt'), 'New synthetic content.\n');
    f.update();
    const renamed = await repoConnector.invoke(
      { ...f.input, previousVersion: first.sourceVersion },
      f.context,
    );
    expect(renamed.files.map((file) => file.relativePath)).toEqual([
      'added.txt',
      'renamed.md',
    ]);
    expect(renamed.renames).toEqual([{ from: 'README.md', to: 'renamed.md' }]);
    await writeFile(join(f.work, 'added.txt'), 'Changed synthetic content.\n');
    f.update();
    const modified = await repoConnector.invoke(
      { ...f.input, previousVersion: renamed.sourceVersion },
      f.context,
    );
    expect(
      modified.files.find((file) => file.relativePath === 'added.txt')?.content,
    ).toBe('Changed synthetic content.\n');
    expect(modified.sourceVersion).not.toBe(renamed.sourceVersion);
  });

  test('reconciles a replaced history and unavailable previous SHA without guessing renames', async () => {
    const f = await fixture();
    fixtureGit(f.work, ['checkout', '--orphan', 'replacement']);
    fixtureGit(f.work, ['rm', '-rf', '.']);
    await writeFile(join(f.work, 'replacement.md'), '# Replacement history\n');
    fixtureGit(f.work, ['branch', '-M', 'main']);
    f.update();
    const result = await repoConnector.invoke(
      { ...f.input, previousVersion: '0'.repeat(40) },
      f.context,
    );
    expect(result.files.map((file) => file.relativePath)).toEqual([
      'replacement.md',
    ]);
    expect(result.renames).toEqual([]);
    expect(result.complete).toBe(true);
  });

  test('records explicitly unsupported objects without treating a read/limit failure as complete', async () => {
    const f = await fixture();
    await writeFile(join(f.work, 'binary.dat'), Buffer.from([0, 1, 2]));
    await writeFile(join(f.work, 'non-utf8.txt'), Buffer.from([255]));
    await writeFile(join(f.work, 'large.txt'), 'x'.repeat(1_048_577));
    await writeFile(
      join(f.work, 'asset.lfs'),
      `version https://git-lfs.github.com/spec/v1\noid sha256:${'0'.repeat(64)}\nsize 4\n`,
    );
    await symlink('README.md', join(f.work, 'link.md'));
    fixtureGit(f.work, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${fixtureGit(f.work, ['rev-parse', 'HEAD'])},submodule`,
    ]);
    // Commit the gitlink separately because add --all would remove its absent working tree.
    fixtureGit(f.work, [
      'add',
      'binary.dat',
      'non-utf8.txt',
      'large.txt',
      'asset.lfs',
      'link.md',
    ]);
    fixtureGit(f.work, [
      'commit',
      '-m',
      'Synthetic unsupported object fixtures',
    ]);
    fixtureGit(f.bare, ['fetch', f.work, '+refs/heads/main:refs/heads/main']);
    const result = await repoConnector.invoke(f.input, f.context);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: 'binary.dat', reason: 'binary' },
        { path: 'non-utf8.txt', reason: 'non_utf8' },
        { path: 'large.txt', reason: 'file_above_1_mib' },
        { path: 'asset.lfs', reason: 'lfs_pointer' },
        { path: 'link.md', reason: 'symlink' },
        { path: 'submodule', reason: 'submodule' },
      ]),
    );
    expect(result.files).toHaveLength(2);
    expect(result.complete).toBe(true);
  });

  test('preserves exact supported UTF-8 bytes including a BOM and CRLF', async () => {
    const f = await fixture();
    const exactBytes = Buffer.from('\uFEFF# Original\r\nChinese: 你好\r\n');
    await writeFile(join(f.work, 'bom.md'), exactBytes);
    f.update();
    const result = await repoConnector.invoke(f.input, f.context);
    const file = result.files.find((entry) => entry.relativePath === 'bom.md');
    expect(file).toBeDefined();
    expect(Buffer.from(file?.content ?? '', 'utf8')).toEqual(exactBytes);
  });

  test.each([
    ['file count', { maxFiles: 1 }, 'FILE_LIMIT'],
    ['byte count', { maxBytes: 1 }, 'BYTE_LIMIT'],
    ['invalid limits', { maxFiles: 0 }, 'INVALID_CONFIG'],
    ['unsafe branch', { branch: '../main' }, 'INVALID_BRANCH'],
    ['unknown branch', { branch: 'missing-branch' }, 'GIT_FAILED'],
  ])(
    'rejects %s and cleans only the invocation scratch directory',
    async (_name, changes, code) => {
      const f = await fixture();
      await writeFile(join(f.scratch, 'keep.txt'), 'Pre-existing caller file');
      await expect(
        repoConnector.invoke({ ...f.input, ...changes }, f.context),
      ).rejects.toThrow(code);
      expect(await readdir(f.scratch)).toEqual(['keep.txt']);
    },
  );

  test.each([
    '-upload-pack=sh',
    'file:///tmp/repo',
    'ssh://git@example.com/repo',
    'https://user:password@example.com/repo',
    'https://example.com/repo?token=fake',
    'https://127.0.0.1/repo',
    'https://localhost/repo',
    'https://[::1]/repo',
  ])(
    'rejects unsafe source %s before making a network request',
    async (repoUrl) => {
      const f = await fixture();
      await expect(
        repoConnector.invoke({ ...f.input, repoUrl }, f.context),
      ).rejects.toThrow('INVALID_SOURCE');
    },
  );

  test('requires an explicit local test root and rejects symlink escapes', async () => {
    const f = await fixture();
    const outside = await fixture();
    await expect(
      repoConnector.invoke(f.input, {
        workDir: f.scratch,
        signal: f.context.signal,
      }),
    ).rejects.toThrow('LOCAL_SOURCE_DENIED');
    await symlink(outside.bare, join(f.root, 'escaped.git'));
    await expect(
      repoConnector.invoke(
        { ...f.input, repoUrl: join(f.root, 'escaped.git') },
        f.context,
      ),
    ).rejects.toThrow('LOCAL_SOURCE_DENIED');
  });

  test('cancels before starting or during Git work, leaving no staging result', async () => {
    const f = await fixture();
    const before = new AbortController();
    before.abort();
    await expect(
      repoConnector.invoke(f.input, { ...f.context, signal: before.signal }),
    ).rejects.toThrow('CANCELLED');
    const running = new AbortController();
    const promise = repoConnector.invoke(f.input, {
      ...f.context,
      signal: running.signal,
    });
    const timer = setTimeout(() => running.abort(), 5);
    await expect(promise).rejects.toThrow('CANCELLED');
    clearTimeout(timer);
    expect(await readdir(f.scratch)).toEqual([]);
  });
});
