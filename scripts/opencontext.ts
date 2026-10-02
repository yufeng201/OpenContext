import {
  safeErrorCode,
  safeErrorMetadata,
} from '../packages/contracts/src/errors.ts';
import { OpenContextClient } from '../packages/http-client/src/index.ts';

async function main(): Promise<void> {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  const options = { signal: controller.signal };
  const [command, ...args] = process.argv.slice(2);
  if (command === 'help' || command === '--help' || !command) {
    console.log(
      'OpenContext query CLI (local preview)\nEnvironment: OPENCONTEXT_URL (default http://127.0.0.1:4310), OPENCONTEXT_QUERY_TOKEN\nCommands: readiness (owner only) | projects | tree PROJECT | search PROJECT QUERY [fts|grep] | read PROJECT FILE REVISION | files PROJECT [LIMIT] [CURSOR]\nOutput: JSON; fixed revision required for read. No mutation, config writes or token flags.',
    );
    return;
  }
  if (
    !['readiness', 'projects', 'tree', 'search', 'read', 'files'].includes(
      command,
    )
  )
    throw new Error('UNKNOWN_COMMAND');
  if (
    (['readiness', 'projects'].includes(command) && args.length !== 0) ||
    (command === 'tree' && args.length !== 1) ||
    (command === 'search' && (args.length < 2 || args.length > 3)) ||
    (command === 'read' && args.length !== 3) ||
    (command === 'files' && (args.length < 1 || args.length > 3))
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
    const report = await client.readiness(options);
    result = report;
    if (!report.ready) process.exitCode = 1;
  } else if (command === 'projects') result = await client.projects(options);
  else if (command === 'tree') result = await client.tree(project, options);
  else if (command === 'read')
    result = await client.read(project, args[1]!, args[2]!, options);
  else if (command === 'files') {
    if (args[1] && !/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/.test(args[1]))
      throw new Error('INVALID_ARGUMENTS');
    result = await client.filesPage(
      project,
      {
        ...(args[1] ? { limit: Number(args[1]) } : {}),
        ...(args[2] ? { cursor: args[2] } : {}),
      },
      options,
    );
  } else {
    const mode = args[2] ?? 'fts';
    if (mode !== 'fts' && mode !== 'grep')
      throw new Error('INVALID_SEARCH_MODE');
    result = await client.search(project, { query: args[1]!, mode }, options);
  }
  console.log(JSON.stringify(result, null, 2));
}
try {
  await main();
} catch (error) {
  const code = safeErrorCode(error, 'REQUEST_FAILED');
  const metadata = safeErrorMetadata(error);
  console.error(
    JSON.stringify({
      error: code,
      ...metadata,
    }),
  );
  process.exitCode = 1;
}
