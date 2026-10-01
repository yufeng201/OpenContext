import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { read, root } from '../../scripts/lib.ts';
import { violations } from '../../scripts/check-boundaries.ts';
import { checkLinks, checkScenario, fences } from '../../scripts/doc-rules.ts';
import { validateSkill } from '../../scripts/check-skills.ts';
import { suspicious } from '../../scripts/check-safety.ts';
import { parse } from 'yaml';

test('boundary allows ports/contracts and local modules', () => {
  for (const [file, specifier] of [
    ['apps/web/src/view.ts', '@opencontext/contracts'],
    ['packages/core/src/files.ts', '@opencontext/contracts'],
    ['plugins/repo/src/main.ts', '@opencontext/plugin-sdk'],
    ['packages/contracts/src/api.ts', '@sinclair/typebox'],
    ['apps/web/src/view.ts', './local.ts'],
    ['apps/web/tests/imports.spec.ts', 'node:fs/promises'],
  ])
    assert.deepEqual(
      violations(file!, 'import x from ' + JSON.stringify(specifier)),
      [],
    );
});
test('boundary rejects direct, relative, export, dynamic, require, import-type violations', () => {
  for (const [file, source] of [
    ['apps/web/src/view.ts', 'import db from "@opencontext/state-sqlite"'],
    [
      'apps/web/src/view.ts',
      'export * from "../../../packages/core/src/files.ts"',
    ],
    ['apps/web/src/view.ts', 'const db = import("node:sqlite")'],
    ['apps/web/src/view.spec.ts', 'import x from "node:fs/promises"'],
    ['apps/web/tests/imports.spec.ts', 'import x from "node:sqlite"'],
    [
      'apps/web/tests/imports.spec.ts',
      'import x from "@opencontext/state-sqlite"',
    ],
    ['packages/core/src/file.ts', 'const f = require("fastify")'],
    ['packages/contracts/src/api.ts', 'import x from "node:fs"'],
    [
      'plugins/repo/src/main.ts',
      'type X = import("@opencontext/state-sqlite").X',
    ],
    ['plugins/repo/src/main.ts', 'const x = import(variable)'],
    ['apps/web/src/main.ts', 'import x from "../../../../outside.ts"'],
  ])
    assert.ok(violations(file!, source!).length > 0, source);
});
test('scenario references and capability mismatches fail instead of silently skipping', () => {
  const value = JSON.parse(
    fences(read(resolve(root, 'docs/IMPLEMENTATION_BLUEPRINT.md')), 'json')[1]!,
  );
  checkScenario(value);
  const missing = structuredClone(value);
  missing.retrieval.embedding = 'org.opencontext.embedding-http@0.1.0';
  assert.throws(() => checkScenario(missing), /capability\/ref/);
  const wrong = structuredClone(value);
  wrong.retrieval.indexer = wrong.retrieval.retriever;
  assert.throws(() => checkScenario(wrong), /capability\/ref/);
  const cycle = structuredClone(value);
  cycle.bindings[0].dependsOn = [cycle.bindings[0].id];
  assert.throws(() => checkScenario(cycle), /cycle/);
  const slot = structuredClone(value);
  const bound = slot.bindings.find(
    (b: { inputs?: { selector: { kind: string } }[] }) =>
      b.inputs?.some((i) => i.selector.kind === 'output-set'),
  );
  bound.inputs.find(
    (i: { selector: { kind: string } }) => i.selector.kind === 'output-set',
  ).selector.slots = ['missing-slot'];
  assert.throws(() => checkScenario(slot), /slot/);
});
test('links and anchors have a real negative fixture', () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'oc-link-fixture-'));
  try {
    const a = resolve(temp, 'a.md');
    writeFileSync(resolve(temp, 'b.md'), '# Target\n');
    writeFileSync(a, '[good](b.md#target)\n');
    assert.equal(checkLinks(a), 1);
    writeFileSync(a, '[bad](missing.md)\n');
    assert.throws(() => checkLinks(a), /missing link/);
    writeFileSync(a, '[bad](b.md#absent)\n');
    assert.throws(() => checkLinks(a), /missing anchor/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
test('skill frontmatter requires trigger metadata and no permission expansion', () => {
  validateSkill(read(resolve(root, '.agents/skills/validate-design/SKILL.md')));
  assert.throws(() => validateSkill('no frontmatter'), /frontmatter/);
  assert.throws(
    () =>
      validateSkill(
        '---\nname: invalid name\ndescription: too short\n---\nbody',
      ),
    /name/,
  );
  assert.throws(
    () =>
      validateSkill(
        '---\nname: x\ndescription: sufficiently specific trigger here\nallowed-tools: Bash\n---\nbody',
      ),
    /permissions/,
  );
});
test('synthetic secret signatures are rejected and opaque refs are allowed', () => {
  assert.equal(suspicious('secret:embedding-provider'), false);
  assert.equal(suspicious('ghp_' + 'A'.repeat(36)), true);
  assert.equal(suspicious('-----BEGIN ' + 'PRIVATE KEY-----'), true);
});
test('CI uses local check, read-only permissions and locked installation', () => {
  const workflow = parse(read(resolve(root, '.github/workflows/check.yml')));
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const commands = workflow.jobs.check.steps
    .map((s: { run?: string }) => s.run)
    .filter(Boolean);
  assert.ok(
    commands.includes('pnpm install --frozen-lockfile --ignore-scripts'),
  );
  assert.ok(commands.includes('pnpm check'));
  const workspace = parse(read(resolve(root, 'pnpm-workspace.yaml')));
  assert.equal(workspace.ignoreScripts, true);
  assert.equal(workspace.engineStrict, true);
});
