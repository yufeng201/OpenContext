import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
import { root, files, read, local, assert } from './lib.ts';
import { checkLinks, fences, checkScenario } from './doc-rules.ts';

const paths = files().filter(
  (p) =>
    p.endsWith('.md') &&
    !/docs\/(checkpoint|original-2026-09-30)\//.test(local(p)),
);
let links = 0,
  jsonCount = 0;
for (const path of paths) {
  const text = read(path);
  assert(
    !text.includes('\r') && text.endsWith('\n'),
    'UTF-8 LF/trailing LF: ' + path,
  );
  links += checkLinks(path);
  for (const block of fences(text, 'json')) {
    JSON.parse(block);
    jsonCount++;
  }
}
const blue = read(resolve(root, 'docs/IMPLEMENTATION_BLUEPRINT.md'));
const journeys = read(resolve(root, 'docs/USER_JOURNEYS.md'));
const scenario = JSON.parse(fences(blue, 'json')[1]!);
checkScenario(scenario);
assert(
  /retrieval: \{ modes: \("fts" \| "grep" \| "vector"\)\[\]; embedding: InstanceRef \| null \}/.test(
    blue,
  ),
  'DeploymentProfile must refer to configured instance, never plugin package',
);
let source =
  fences(blue, 'ts').join('\n\n') +
  '\nconst scenario = ' +
  JSON.stringify(scenario) +
  ' satisfies ScenarioConfig;\n';
for (const [i, json] of fences(journeys, 'json').entries()) {
  source +=
    '\nconst userConfig' +
    i +
    ' = ' +
    json.trim() +
    ' satisfies ' +
    (i === 0 ? 'DeploymentProfile' : 'ClientProfile') +
    ';\n';
}
source += read(resolve(root, 'tests/design/semantic-fixtures.ts.txt'));
const temporary = mkdtempSync(resolve(tmpdir(), 'opencontext-docs-'));
try {
  const path = resolve(temporary, 'examples.ts');
  writeFileSync(path, source);
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    outDir: temporary,
    types: [],
    skipLibCheck: false,
    noEmitOnError: true,
  };
  const program = ts.createProgram([path], options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length)
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (p) => p,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
      }),
    );
  assert(!program.emit().emitSkipped, 'Example emit failed');
  const ruleReport = execFileSync(
    process.execPath,
    [resolve(temporary, 'examples.js')],
    { encoding: 'utf8' },
  ).trim();
  for (const path of paths)
    for (const block of fences(read(path), 'sh')) {
      execFileSync('bash', ['-n'], { input: block });
    }
  const db = new DatabaseSync(':memory:');
  for (const sql of fences(blue, 'sql')) db.exec(sql);
  const tables = db
    .prepare("select count(*) as n from sqlite_master where type='table'")
    .get();
  db.close();
  console.log(
    JSON.stringify(
      {
        jsonExamples: jsonCount,
        tsFences: fences(blue, 'ts').length,
        relativeLinks: links,
        sqliteTables: tables?.n,
        designRules: JSON.parse(ruleReport),
        applicationE2E:
          'NOT RUN BY THIS DOCUMENT CHECK; see test:app and web test:browser',
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
