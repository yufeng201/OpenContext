import { execFileSync } from 'node:child_process';
import { root, files, read, local, assert, main } from './lib.ts';

export function suspicious(text: string): boolean {
  return (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) ||
    /\bghp_[A-Za-z0-9]{30,}\b/.test(text) ||
    /\bsk-[A-Za-z0-9]{30,}\b/.test(text)
  );
}
export function checkSafety(): void {
  const ignored = [
    '.env',
    '.env.local',
    'apps/web/.env.production',
    'secrets/token.txt',
    'credentials/auth.json',
    'data/a.jsonl',
    'runtime/a.bin',
    'staging/a.md',
    'backups/all.zip',
    'state/control.sqlite',
    'state/control.sqlite-wal',
    'local.key',
    'node_modules/a.js',
    '.cache/store/x',
    '.codex/auth.json',
    '.claude/settings.local.json',
    'docs/checkpoint/PRD.md',
    'docs/original-2026-09-30/PRD.md',
  ];
  const visible = [
    '.env.example',
    'package.json',
    'pnpm-lock.yaml',
    'docs/PRD.md',
    '.agents/skills/validate-design/SKILL.md',
    '.claude/skills/validate-design/SKILL.md',
  ];
  const output = execFileSync(
    'git',
    ['check-ignore', '--no-index', '--stdin'],
    {
      cwd: root,
      input: [...ignored, ...visible].join('\n') + '\n',
      encoding: 'utf8',
    },
  );
  const actual = new Set(output.trim().split('\n'));
  for (const path of ignored)
    assert(actual.has(path), 'Unsafe ignore default: ' + path);
  for (const path of visible)
    assert(!actual.has(path), 'Required source hidden: ' + path);
  // Scan only source/text candidates; no reading ignored credentials or runtime data.
  const paths = files().filter((p) =>
    /\.(md|ts|mjs|json|yaml|yml|txt)$/.test(p),
  );
  const ignoredPaths = new Set(
    execFileSync('git', ['check-ignore', '--no-index', '--stdin'], {
      cwd: root,
      input: [...paths.map(local), '.env'].join('\n') + '\n',
      encoding: 'utf8',
    })
      .trim()
      .split('\n'),
  );
  for (const p of paths)
    if (!ignoredPaths.has(local(p)))
      assert(!suspicious(read(p)), 'Possible secret in ' + local(p));
  console.log(
    'Safety: ' +
      ignored.length +
      ' ignored / ' +
      visible.length +
      ' visible path fixtures; bounded secret-pattern check. Not a complete secret scanner.',
  );
}
if (main(import.meta.url)) checkSafety();
