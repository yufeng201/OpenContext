import {
  OpenContextClient,
  OpenContextError,
} from '../packages/http-client/src/index.ts';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || !command) {
    console.log(
      'OpenContext query CLI (local preview)\nEnvironment: OPENCONTEXT_URL (default http://127.0.0.1:4310), OPENCONTEXT_QUERY_TOKEN\nCommands: readiness (owner only) | projects | tree PROJECT | search PROJECT QUERY [fts|grep] | read PROJECT FILE REVISION\nOutput: JSON; fixed revision required for read. No mutation, config writes or token flags.',
    );
    return;
  }
  if (!['readiness', 'projects', 'tree', 'search', 'read'].includes(command))
    throw new Error('UNKNOWN_COMMAND');
  if (
    (['readiness', 'projects'].includes(command) && args.length !== 0) ||
    (command === 'tree' && args.length !== 1) ||
    (command === 'search' && (args.length < 2 || args.length > 3)) ||
    (command === 'read' && args.length !== 3)
  )
    throw new Error('INVALID_ARGUMENTS');
  const token = process.env['OPENCONTEXT_QUERY_TOKEN'];
  if (!token) throw new Error('MISSING_QUERY_TOKEN');
  const client = new OpenContextClient({
    baseUrl: process.env['OPENCONTEXT_URL'] ?? 'http://127.0.0.1:4310',
    token,
  });
  const project = args[0]!;
  let result: unknown;
  if (command === 'readiness') {
    const report = await client.readiness();
    result = report;
    if (!report.ready) process.exitCode = 1;
  } else if (command === 'projects') result = await client.projects();
  else if (command === 'tree') result = await client.tree(project);
  else if (command === 'read')
    result = await client.read(project, args[1]!, args[2]!);
  else {
    const mode = args[2] ?? 'fts';
    if (mode !== 'fts' && mode !== 'grep')
      throw new Error('INVALID_SEARCH_MODE');
    result = await client.search(project, { query: args[1]!, mode });
  }
  console.log(JSON.stringify(result, null, 2));
}
try {
  await main();
} catch (error) {
  const code =
    error instanceof OpenContextError
      ? error.code
      : error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'REQUEST_FAILED';
  console.error(
    JSON.stringify({
      error: code,
      ...(error instanceof OpenContextError
        ? { status: error.status, correlationId: error.correlationId }
        : {}),
    }),
  );
  process.exitCode = 1;
}
