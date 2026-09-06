import { createServer } from '../dist/server.js';
import { shutdownHttpServer } from '../dist/server-shutdown.js';

if (!process.send) throw new Error('Use the deployment launcher to start this owned service.');
const server = createServer();
let stopping = false;
const listener = server.app.listen(server.config.port, server.config.host, () => {
  process.send?.({ type: 'devspace.ready', host: server.config.host, port: server.config.port });
});
const stop = async (exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  try {
    await shutdownHttpServer(listener, server.close);
    process.exit(exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};
listener.once('error', error => {
  console.error(error.message);
  void stop(1);
});
process.on('message', message => {
  if (message?.type === 'devspace.stop') void stop();
});
process.once('disconnect', () => void stop());
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
