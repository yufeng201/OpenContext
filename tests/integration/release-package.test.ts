import { it, expect } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { packageRelease } from '../../scripts/package-release.ts';
it('creates a deterministic content manifest from the allowlist and excludes unrelated state/secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'oc-release-package-')),
    source = join(root, 'source');
  function file(path: string, content = 'synthetic') {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), content);
  }
  try {
    for (const path of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.node-version',
      'apps/server/package.json',
      'apps/web/package.json',
      'apps/server/src/main.ts',
      'apps/web/dist/index.html',
      'packages/contracts/package.json',
      'packages/contracts/src/index.ts',
      'plugins/fixture/package.json',
      'plugins/fixture/src/index.ts',
      'scripts/admin.ts',
      'scripts/preflight.ts',
      'scripts/opencontext.ts',
      'deploy/Dockerfile',
      'deploy/compose.yaml',
      'deploy/opencontext.service',
      'docs/PRODUCTION_RUNBOOK.md',
      'docs/DEPLOYMENT_SECURITY.md',
      'docs/BACKUP_RECOVERY.md',
      'runtime/control.sqlite',
      '.env',
      'secrets/owner',
    ])
      file(path);
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--quiet'], {
      cwd: source,
    });
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'synthetic',
      ],
      { cwd: source },
    );
    packageRelease(source, join(root, 'first'));
    packageRelease(source, join(root, 'second'));
    const manifest = JSON.parse(
      readFileSync(join(root, 'first/release-manifest.json'), 'utf8'),
    );
    expect(manifest.sourceDirty).toBe(false);
    expect(
      readFileSync(join(root, 'second/release-manifest.json'), 'utf8'),
    ).toBe(readFileSync(join(root, 'first/release-manifest.json'), 'utf8'));
    for (const path of [
      'runtime/control.sqlite',
      '.env',
      'secrets/owner',
      '.git',
    ])
      expect(existsSync(join(root, 'first', path))).toBe(false);
    expect(manifest.files['.dockerignore']).toMatch(/^[a-f0-9]{64}$/);
    expect(
      readFileSync(join(root, 'first/.dockerignore'), 'utf8'),
    ).not.toContain('!packages/**');
    expect(manifest.files['apps/server/src/main.ts']).toMatch(/^[a-f0-9]{64}$/);
    renameSync(join(source, 'apps/server'), join(source, 'original-server'));
    symlinkSync(join(source, 'original-server'), join(source, 'apps/server'));
    expect(() => packageRelease(source, join(root, 'linked'))).toThrow(
      'RELEASE_SYMLINK_DENIED',
    );
    expect(existsSync(join(root, 'linked'))).toBe(false);
    rmSync(join(source, 'apps/server'));
    renameSync(join(source, 'original-server'), join(source, 'apps/server'));
    file('apps/server/src/.env', 'synthetic-private-marker');
    expect(() => packageRelease(source, join(root, 'denied'))).toThrow(
      'RELEASE_FILE_DENIED',
    );
    expect(existsSync(join(root, 'denied'))).toBe(false);
    expect(() => packageRelease(source, source)).toThrow(
      'INVALID_RELEASE_TARGET',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
