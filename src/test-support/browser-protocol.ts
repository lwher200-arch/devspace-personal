import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export async function waitForBrowserEndpoint(filename: string, options: {
  timeoutMs?: number;
  stopped?: () => Error | undefined;
  read?: () => Promise<string>;
  wait?: () => Promise<void>;
  now?: () => number;
} = {}): Promise<{ port: number; path: string }> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 12000);
  const read = options.read ?? (() => readFile(filename, 'utf8'));
  while (now() < deadline) {
    const stopped = options.stopped?.();
    if (stopped) throw stopped;
    try {
      const [rawPort, path] = (await read()).trim().split(/\r?\n/);
      const port = Number(rawPort);
      if (Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[a-z0-9-]+$/i.test(path ?? '')) {
        return { port, path };
      }
    } catch (error) {
      // Chromium may create the file before releasing its Windows handle or
      // completing both lines. Retry only startup reads, never browser actions.
      if (!['ENOENT', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    await (options.wait?.() ?? delay(50));
  }
  throw new Error('Browser debugging endpoint did not become ready before the deadline.');
}

// Minimal CDP client shared by isolated browser regression fixtures.
export class BrowserProtocol {
  private sequence = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private socket: WebSocket) {
    socket.addEventListener('message', event => {
      const value = JSON.parse(String(event.data));
      const entry = this.pending.get(value.id);
      if (!entry) return;
      this.pending.delete(value.id); clearTimeout(entry.timer);
      if (value.error) entry.reject(new Error(value.error.message)); else entry.resolve(value.result);
    });
    socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Test browser closed.')); }
      this.pending.clear();
    });
  }
  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Browser timeout: ${method}`)); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  disconnect() { this.socket.close(); }
}
