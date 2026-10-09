import { safeErrorCode } from '../packages/contracts/src/errors.ts';
import { uploadSessions } from './session-memory-upload-client.ts';

const [option, selection, ...extra] = process.argv.slice(2);
if (option === '--help' || option === 'help') {
  console.log(
    'Usage: pnpm session-memory:upload --file PATH | --directory PATH\nExplicit local JSONL selection only; server must enable inputMode=upload and a supported Codex format. Uses existing OPENCONTEXT_URL/OPENCONTEXT_OWNER_TOKEN. Sends a metadata-minimized completed-text projection, not machine paths/environment. At most one transport retry with identical bytes. SIGINT stops client requests; an accepted server upload may finish. Inspect status; cancel TASK_ID cancels review, not imported source.',
  );
} else {
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  try {
    if (
      !['--file', '--directory'].includes(option ?? '') ||
      !selection ||
      extra.length
    )
      throw new Error('INVALID_CONFIG');
    const result = await uploadSessions({
      selection,
      kind: option === '--file' ? 'file' : 'directory',
      origin: process.env['OPENCONTEXT_URL'] ?? 'http://127.0.0.1:4310',
      token: process.env['OPENCONTEXT_OWNER_TOKEN'] ?? '',
      signal: abort.signal,
    });
    console.log(JSON.stringify(result, null, 2));
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
}
