import {
  prepareWorker,
  workerStatus,
  runWorker,
  cancelWorker,
} from './local-agent-worker.ts';
import { submitWorker } from './local-agent-submit.ts';
import { safeErrorCode } from '../packages/contracts/src/errors.ts';

const [command, argument, execution, ...extra] = process.argv.slice(2);
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
try {
  if (!command || ['help', '--help'].includes(command))
    console.log(
      'Local worker (no execution by default): prepare TASK_JSON | status JOB_DIR | run JOB_DIR --execute-model | retry JOB_DIR --execute-model | cancel JOB_DIR | submit JOB_DIR\nRun/retry refuse server owner/query credentials in their environment, use only fixed Codex 0.161.0 arguments and an isolated Codex home. No login/config copying. Submit is a separate credential-bearing invocation and never starts a process. At most three explicit attempts; no automatic model retry. Review/approve remains separate.',
    );
  else {
    if (
      !argument ||
      extra.length ||
      !['prepare', 'status', 'run', 'retry', 'cancel', 'submit'].includes(
        command,
      ) ||
      (['run', 'retry'].includes(command)
        ? execution !== '--execute-model'
        : execution !== undefined)
    )
      throw new Error('INVALID_CONFIG');
    let result: unknown;
    if (command === 'prepare') result = prepareWorker(argument);
    else if (command === 'status') result = workerStatus(argument);
    else if (command === 'cancel') {
      cancelWorker(argument);
      result = workerStatus(argument);
    } else if (command === 'submit')
      result = await submitWorker(argument, {
        origin: process.env['OPENCONTEXT_URL'] ?? 'http://127.0.0.1:4310',
        token: process.env['OPENCONTEXT_OWNER_TOKEN'] ?? '',
        signal: abort.signal,
      });
    else {
      const finished = await runWorker(argument, {
        execute: true,
        retry: command === 'retry',
        signal: abort.signal,
      });
      result = {
        ...workerStatus(argument),
        responsePath: finished.responsePath,
        cached: finished.cached,
      };
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      error: abort.signal.aborted
        ? 'CANCELLED'
        : safeErrorCode(error, 'PROCESSING_FAILED'),
    }),
  );
  process.exitCode = 1;
}
