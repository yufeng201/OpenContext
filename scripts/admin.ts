import {
  createBackup,
  verifyBackup,
  restoreBackup,
  acquireStoppedLock,
  inspectStorage,
} from '../packages/state-sqlite/src/maintenance.ts';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(
      'OpenContext offline operator CLI\nStop the server and every external writer first. Filesystem operator authority; never a reader-token API.\nCommands: backup DATA_ROOT NEW_SNAPSHOT | verify SNAPSHOT | restore SNAPSHOT NEW_DATA_ROOT | diagnose STOPPED_DATA_ROOT\nAll destinations must not exist; incomplete destinations stay quarantined. Private snapshots include user data/token hashes; no encryption/signing.',
    );
    return;
  }
  if (process.env['OPENCONTEXT_QUERY_TOKEN'] !== undefined)
    throw new Error('QUERY_CREDENTIAL_NOT_ALLOWED');
  if (!['backup', 'verify', 'restore', 'diagnose'].includes(command))
    throw new Error('UNKNOWN_COMMAND');
  if (args.length !== (['backup', 'restore'].includes(command) ? 2 : 1))
    throw new Error('INVALID_ARGUMENTS');
  let result: unknown;
  if (command === 'backup') result = await createBackup(args[0]!, args[1]!);
  else if (command === 'verify') {
    const m = verifyBackup(args[0]!);
    result = {
      id: m.id,
      format: m.format,
      version: m.version,
      files: m.files.length,
      mode: m.mode,
    };
  } else if (command === 'restore') result = restoreBackup(args[0]!, args[1]!);
  else {
    const lock = acquireStoppedLock(args[0]!);
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(resolve(args[0]!, 'control.sqlite'), {
        readOnly: true,
      });
      const check = inspectStorage(args[0]!, db);
      result = check;
      if (!check.ready) process.exitCode = 1;
    } finally {
      db?.close();
      lock.close();
    }
  }
  console.log(JSON.stringify(result, null, 2));
}
try {
  await main();
} catch (error) {
  const code =
    error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'OPERATION_FAILED';
  console.error(JSON.stringify({ error: code }));
  process.exitCode = 1;
}
