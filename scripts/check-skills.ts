import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parse } from 'yaml';
import { root, files, read, assert, main } from './lib.ts';
import { checkLinks } from './doc-rules.ts';

export function validateSkill(text: string): void {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]+)/.exec(text);
  assert(match, 'Skill needs YAML frontmatter and body');
  const meta = parse(match[1]!) as Record<string, unknown>;
  assert(
    typeof meta.name === 'string' && /^[a-z0-9-]+$/.test(meta.name),
    'Invalid skill name',
  );
  assert(
    typeof meta.description === 'string' && meta.description.length > 20,
    'Skill description must explain trigger',
  );
  assert(
    !('allowed-tools' in meta),
    'Do not expand execution permissions through this skill',
  );
}
export function checkSkills(write = false): void {
  const canonicalRoot = resolve(root, '.agents/skills');
  const paths = files(canonicalRoot).filter((p) => p.endsWith('/SKILL.md'));
  assert(paths.length > 0, 'No discoverable skills');
  for (const path of paths) {
    const text = read(path);
    validateSkill(text);
    const mirror = path.replace('/.agents/skills/', '/.claude/skills/');
    if (write) {
      mkdirSync(dirname(mirror), { recursive: true });
      writeFileSync(mirror, text);
    }
    assert(read(mirror) === text, 'Skill mirror drift; run pnpm sync:skills');
    checkLinks(path);
    checkLinks(mirror);
    const pkg = JSON.parse(read(resolve(root, 'package.json'))) as {
      scripts: Record<string, string>;
    };
    for (const match of text.matchAll(/pnpm ([a-z][a-z:-]+)/g)) {
      assert(
        match[1]! in pkg.scripts,
        'Skill invokes missing command: ' + match[1],
      );
    }
  }
  const agents = files().filter((p) => p.endsWith('/AGENTS.md'));
  for (const path of agents) {
    checkLinks(path);
    const claude = resolve(dirname(path), 'CLAUDE.md');
    assert(
      read(claude).trim() === '@AGENTS.md',
      'Claude entry must import a single rule source',
    );
  }
  console.log(
    'Skills: ' +
      paths.length +
      ' canonical/mirror pairs; ' +
      agents.length +
      ' AGENTS imports checked. Native client discovery is a separate compatibility check.',
  );
}
if (main(import.meta.url)) checkSkills(process.argv.includes('--write'));
