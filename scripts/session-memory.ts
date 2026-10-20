import { readLocalText } from '../packages/plugin-sdk/src/index.ts';
import { safeErrorCode } from '../packages/contracts/src/errors.ts';
import {
  sessionMemory,
  type MemoryCommand,
} from './session-memory-workflow.ts';
import { setTimeout as delay } from 'node:timers/promises';

const [command, configPath, argument, ...extra] = process.argv.slice(2);
try {
  if (!command || command === 'help' || command === '--help') {
    console.log(
      'Offline local session memory (disabled by default). Stop the server first. No credentials, model calls or Agent configuration writes.\nCommands: sync CONFIG | status CONFIG | submit CONFIG RESPONSE_JSON | approve CONFIG REVIEW_SHA256 | retry CONFIG | cancel CONFIG | watch CONFIG CYCLES INTERVAL_MS\nwatch requires 1–60 cycles and 1000–60000 ms; it only syncs and creates tasks, never approves. Only explicitly selected complete Codex export JSON files are scanned. Unchanged content retains the task checkpoint. Review publication does not approve or install system rules.',
    );
  } else {
    if (process.env['OPENCONTEXT_QUERY_TOKEN'] !== undefined)
      throw new Error('POLICY_DENIED');
    if (
      ![
        'sync',
        'status',
        'submit',
        'approve',
        'retry',
        'cancel',
        'watch',
      ].includes(command) ||
      !configPath ||
      (command === 'watch'
        ? extra.length !== 1 ||
          !/^(?:[1-9]|[1-5][0-9]|60)$/.test(argument ?? '') ||
          !/^[0-9]+$/.test(extra[0] ?? '') ||
          Number(extra[0]) < 1000 ||
          Number(extra[0]) > 60_000
        : extra.length !== 0 ||
          (['submit', 'approve'].includes(command)
            ? !argument
            : argument !== undefined))
    )
      throw new Error('INVALID_CONFIG');
    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort());
    process.once('SIGTERM', () => abort.abort());
    const config: unknown = JSON.parse(readLocalText(configPath, 65_536));
    const cycles = command === 'watch' ? Number(argument) : 1;
    for (let cycle = 0; cycle < cycles; cycle++) {
      const result = await sessionMemory(
        config,
        command === 'watch' ? 'sync' : (command as MemoryCommand),
        command === 'watch' ? undefined : argument,
        abort.signal,
      );
      console.log(JSON.stringify(result, null, 2));
      if (result.status === 'disabled') break;
      if (cycle + 1 < cycles)
        await delay(Number(extra[0]), undefined, { signal: abort.signal });
    }
  }
} catch (error) {
  console.error(
    JSON.stringify({ error: safeErrorCode(error, 'PROCESSING_FAILED') }),
  );
  process.exitCode = 1;
}
