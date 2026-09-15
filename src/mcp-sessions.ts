export interface ClosableMcpTransport {
  close(): Promise<void>;
}

export interface McpSessionCloseResult {
  sessionId: string;
  error?: unknown;
}

interface McpSessionEntry<TTransport> {
  transport: TTransport;
  lastActivityAt: number;
  activeRequests: number;
  httpRequests: Map<string | number, { pending: Set<string | number>; cancelled: boolean; release(): void }>;
}

export interface McpSessionRegistryOptions {
  now?: () => number;
  maxSessions?: number;
}

export interface McpSessionReservation<TTransport> {
  closed: McpSessionCloseResult[];
  register(sessionId: string, transport: TTransport): void;
  release(): void;
}

export class McpSessionRegistry<TTransport extends ClosableMcpTransport> {
  private readonly sessions = new Map<string, McpSessionEntry<TTransport>>();
  private readonly now: () => number;
  private readonly maxSessions: number;
  private reservations = 0;

  constructor(options: McpSessionRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? 32;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions < 1) {
      throw new RangeError("MCP session capacity must be a positive integer.");
    }
  }

  get size(): number { return this.sessions.size; }

  /** Reserve before constructing a server; concurrent initializations count too. */
  async reserve(): Promise<McpSessionReservation<TTransport> | undefined> {
    let evicted: { sessionId: string; transport: TTransport } | undefined;
    if (this.sessions.size + this.reservations >= this.maxSessions) {
      let oldest: [string, McpSessionEntry<TTransport>] | undefined;
      for (const candidate of this.sessions) {
        if (candidate[1].activeRequests === 0 &&
          (!oldest || candidate[1].lastActivityAt < oldest[1].lastActivityAt)) oldest = candidate;
      }
      if (!oldest) return undefined;
      this.sessions.delete(oldest[0]);
      evicted = { sessionId: oldest[0], transport: oldest[1].transport };
    }
    this.reservations++;
    let held = true;
    const release = () => { if (held) { held = false; this.reservations--; } };
    // Removal and reservation are synchronous; no competing request can reuse
    // the evicted transport or overbook this slot while close is pending.
    const closed = evicted ? await closeSessions([evicted]) : [];
    return {
      closed,
      register: (sessionId, transport) => {
        if (!held) throw new Error("MCP session reservation was already released.");
        if (this.sessions.has(sessionId)) throw new Error("MCP session is already registered.");
        release();
        this.install(sessionId, transport);
      },
      release,
    };
  }

  register(sessionId: string, transport: TTransport): void {
    if (this.sessions.has(sessionId)) throw new Error("MCP session is already registered.");
    if (this.sessions.size + this.reservations >= this.maxSessions) {
      throw new Error("MCP session capacity reached; reserve a slot before creating a server.");
    }
    this.install(sessionId, transport);
  }

  private install(sessionId: string, transport: TTransport): void {
    this.sessions.set(sessionId, { transport, lastActivityAt: this.now(), activeRequests: 0, httpRequests: new Map() });
  }

  get(sessionId: string): TTransport | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    entry.lastActivityAt = this.now();
    return entry.transport;
  }

  /** A handler can outlive its HTTP response, so each owner releases its own lease. */
  beginRequest(sessionId: string): (() => void) | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) return undefined;
    entry.activeRequests++;
    entry.lastActivityAt = this.now();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      entry.activeRequests--;
      entry.lastActivityAt = this.now();
    };
  }

  beginHttpRequest(sessionId: string, requestIds: Array<string | number>): (() => void) | undefined {
    const entry = this.sessions.get(sessionId), finish = this.beginRequest(sessionId);
    if (!entry || !finish) return undefined;
    const owner = { pending: new Set(requestIds), cancelled: false, release: () => {
      for (const id of requestIds) if (entry.httpRequests.get(id) === owner) entry.httpRequests.delete(id);
      finish();
    } };
    for (const id of requestIds) entry.httpRequests.set(id, owner);
    return owner.release;
  }

  /** Cancelled handlers produce no reply in the SDK. A batch's other replies must
   * finish sending before its otherwise unending HTTP lease can be released. */
  settleRequest(sessionId: string, requestId: string | number, cancelled = false): void {
    const owner = this.sessions.get(sessionId)?.httpRequests.get(requestId);
    if (!owner) return;
    owner.pending.delete(requestId);
    owner.cancelled ||= cancelled;
    if (owner.cancelled && owner.pending.size === 0) owner.release();
  }

  remove(sessionId: string): boolean { return this.sessions.delete(sessionId); }

  async closeIdle(idleTimeoutMs: number): Promise<McpSessionCloseResult[]> {
    const cutoff = this.now() - idleTimeoutMs;
    const idleSessions: Array<{ sessionId: string; transport: TTransport }> = [];
    for (const [sessionId, entry] of this.sessions) {
      if (entry.activeRequests > 0 || entry.lastActivityAt > cutoff) continue;
      this.sessions.delete(sessionId);
      idleSessions.push({ sessionId, transport: entry.transport });
    }
    return closeSessions(idleSessions);
  }

  async closeAll(): Promise<McpSessionCloseResult[]> {
    const sessions = Array.from(this.sessions, ([sessionId, entry]) => ({ sessionId, transport: entry.transport }));
    this.sessions.clear();
    return closeSessions(sessions);
  }
}

async function closeSessions<TTransport extends ClosableMcpTransport>(
  sessions: Array<{ sessionId: string; transport: TTransport }>,
): Promise<McpSessionCloseResult[]> {
  return Promise.all(sessions.map(async ({ sessionId, transport }) => {
    try { await transport.close(); return { sessionId }; }
    catch (error) { return { sessionId, error }; }
  }));
}
