import type { FastifyInstance } from 'fastify';
import { safeErrorCode } from '@opencontext/contracts/errors';

/** Same entry lifecycle for packaged Node and synthetic child-process checks. */
export async function serve(
  app: FastifyInstance,
  config: {
    host: string;
    port: number;
    shutdownTimeoutMs: number;
  },
): Promise<string> {
  let closing = false;
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    console.log(JSON.stringify({ event: 'shutdown_started' }));
    const deadline = setTimeout(() => {
      console.error(JSON.stringify({ error: 'SHUTDOWN_TIMEOUT' }));
      process.exit(1);
    }, config.shutdownTimeoutMs);
    deadline.unref();
    try {
      await app.close();
      console.log(JSON.stringify({ event: 'shutdown_complete' }));
    } catch (error) {
      console.error(
        JSON.stringify({ error: safeErrorCode(error, 'SHUTDOWN_FAILED') }),
      );
      process.exit(1);
    } finally {
      clearTimeout(deadline);
      process.removeListener('SIGINT', signal);
      process.removeListener('SIGTERM', signal);
    }
  }
  const signal = () => {
    void shutdown();
  };
  process.on('SIGINT', signal);
  process.on('SIGTERM', signal);
  try {
    return await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    process.removeListener('SIGINT', signal);
    process.removeListener('SIGTERM', signal);
    await app.close();
    throw error;
  }
}
