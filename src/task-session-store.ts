import { randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export type TaskSessionStatus = "active" | "checkpointing" | "rebinding" | "degraded" | "closed";
export type TaskSessionBindingState = "current" | "superseded" | "abandoned";

export interface TaskSessionRecord {
  id: string;
  workspaceSessionId: string;
  status: TaskSessionStatus;
  currentConversationScopeId?: string;
  lineageVersion: number;
  nextEventSeq: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskSessionBindingRecord {
  taskSessionId: string;
  conversationScopeId: string;
  state: TaskSessionBindingState;
  generation: number;
  boundAt: string;
  supersededAt?: string;
}

export type TaskSessionConflictCode =
  | "TASK_NOT_FOUND"
  | "TASK_CLOSED"
  | "SOURCE_MISMATCH"
  | "INVALID_DESTINATION"
  | "DESTINATION_OWNED"
  | "DESTINATION_RETIRED"
  | "CORRUPT_BINDING";

export class TaskSessionConflictError extends Error {
  constructor(
    public readonly code: TaskSessionConflictCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskSessionConflictError";
  }
}

interface TaskSessionRow {
  id: string;
  workspace_session_id: string;
  status: string;
  current_conversation_scope_id: string | null;
  lineage_version: number;
  next_event_seq: number;
  created_at: string;
  updated_at: string;
}

interface TaskSessionBindingRow {
  task_session_id: string;
  conversation_scope_id: string;
  state: string;
  generation: number;
  bound_at: string;
  superseded_at: string | null;
}

export class SqliteTaskSessionStore {
  private readonly database: DatabaseHandle;

  constructor(
    stateDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.database = openDatabase(stateDir);
  }

  create(input: {
    workspaceSessionId: string;
    conversationScopeId?: string;
  }): TaskSessionRecord {
    const create = this.database.sqlite.transaction(() => {
      const id = `task_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const createdAt = this.now();
      const conversationScopeId = normalizedConversation(input.conversationScopeId);
      if (conversationScopeId) this.assertDestinationAvailable(id, conversationScopeId);

      this.database.sqlite.prepare(`insert into task_sessions (
        id, workspace_session_id, status, current_conversation_scope_id,
        lineage_version, next_event_seq, created_at, updated_at
      ) values (?, ?, 'active', ?, 1, 1, ?, ?)`).run(
        id,
        input.workspaceSessionId,
        conversationScopeId ?? null,
        createdAt,
        createdAt,
      );

      if (conversationScopeId) {
        this.database.sqlite.prepare(`insert into task_session_bindings (
          task_session_id, conversation_scope_id, state, generation, bound_at, superseded_at
        ) values (?, ?, 'current', 1, ?, null)`).run(id, conversationScopeId, createdAt);
      }

      return this.requireRow(id);
    });

    return rowToTaskSession(create.immediate());
  }

  get(id: string): TaskSessionRecord | undefined {
    const row = this.readRow(id);
    return row ? rowToTaskSession(row) : undefined;
  }

  getByConversationScopeId(conversationScopeId: string): TaskSessionRecord | undefined {
    const row = this.database.sqlite.prepare(`
      select task.*
      from task_sessions task
      join task_session_bindings binding on binding.task_session_id = task.id
      where binding.conversation_scope_id = ? and binding.state = 'current'
      limit 1
    `).get(conversationScopeId) as TaskSessionRow | undefined;
    return row ? rowToTaskSession(row) : undefined;
  }

  listBindings(taskSessionId: string): TaskSessionBindingRecord[] {
    const rows = this.database.sqlite.prepare(`
      select * from task_session_bindings
      where task_session_id = ?
      order by generation asc
    `).all(taskSessionId) as TaskSessionBindingRow[];
    return rows.map(rowToTaskSessionBinding);
  }

  rebind(
    taskSessionId: string,
    expectedConversationScopeId: string | null,
    destinationConversationScopeId: string,
  ): TaskSessionRecord {
    const destination = normalizedConversation(destinationConversationScopeId);
    if (!destination) {
      throw new TaskSessionConflictError("INVALID_DESTINATION", "Destination conversation must be non-empty.");
    }

    const rebind = this.database.sqlite.transaction(() => {
      const current = this.readRow(taskSessionId);
      if (!current) {
        throw new TaskSessionConflictError("TASK_NOT_FOUND", `Unknown task session: ${taskSessionId}.`);
      }
      if (current.status === "closed") {
        throw new TaskSessionConflictError("TASK_CLOSED", `Task session ${taskSessionId} is closed.`);
      }

      const expected = normalizedConversation(expectedConversationScopeId ?? undefined) ?? null;
      if (current.current_conversation_scope_id !== expected) {
        throw new TaskSessionConflictError(
          "SOURCE_MISMATCH",
          `Task session ${taskSessionId} is attached to ${current.current_conversation_scope_id ?? "no conversation"}, not ${expected ?? "no conversation"}.`,
        );
      }

      if (current.current_conversation_scope_id === destination) return current;

      const historical = this.readBinding(taskSessionId, destination);
      if (historical) {
        throw new TaskSessionConflictError(
          "DESTINATION_RETIRED",
          `Conversation ${destination} already belongs to task session ${taskSessionId} as ${historical.state}.`,
        );
      }
      this.assertDestinationAvailable(taskSessionId, destination);

      const updatedAt = this.now();
      let generation = current.lineage_version;
      if (current.current_conversation_scope_id !== null) {
        const source = this.readBinding(taskSessionId, current.current_conversation_scope_id);
        if (!source || source.state !== "current" || source.generation !== current.lineage_version) {
          throw new TaskSessionConflictError(
            "CORRUPT_BINDING",
            `Task session ${taskSessionId} has no current binding matching its durable attachment.`,
          );
        }
        const changed = this.database.sqlite.prepare(`
          update task_session_bindings
          set state = 'superseded', superseded_at = ?
          where task_session_id = ? and conversation_scope_id = ? and state = 'current'
        `).run(updatedAt, taskSessionId, current.current_conversation_scope_id);
        if (changed.changes !== 1) {
          throw new TaskSessionConflictError("CORRUPT_BINDING", "The source binding changed during rebind.");
        }
        generation += 1;
      }

      this.database.sqlite.prepare(`insert into task_session_bindings (
        task_session_id, conversation_scope_id, state, generation, bound_at, superseded_at
      ) values (?, ?, 'current', ?, ?, null)`).run(taskSessionId, destination, generation, updatedAt);

      const changed = this.database.sqlite.prepare(`
        update task_sessions
        set current_conversation_scope_id = ?, lineage_version = ?, updated_at = ?
        where id = ? and current_conversation_scope_id is ? and lineage_version = ?
      `).run(
        destination,
        generation,
        updatedAt,
        taskSessionId,
        current.current_conversation_scope_id,
        current.lineage_version,
      );
      if (changed.changes !== 1) {
        throw new TaskSessionConflictError("SOURCE_MISMATCH", "The task attachment changed during rebind.");
      }

      return this.requireRow(taskSessionId);
    });

    return rowToTaskSession(rebind.immediate());
  }

  checkReady(): void {
    this.database.sqlite.prepare("select 1 from task_sessions limit 1").get();
  }

  close(): void {
    this.database.close();
  }

  private readRow(id: string): TaskSessionRow | undefined {
    return this.database.sqlite.prepare("select * from task_sessions where id = ? limit 1").get(id) as
      TaskSessionRow | undefined;
  }

  private requireRow(id: string): TaskSessionRow {
    const row = this.readRow(id);
    if (!row) throw new TaskSessionConflictError("TASK_NOT_FOUND", `Unknown task session: ${id}.`);
    return row;
  }

  private readBinding(taskSessionId: string, conversationScopeId: string): TaskSessionBindingRow | undefined {
    return this.database.sqlite.prepare(`
      select * from task_session_bindings
      where task_session_id = ? and conversation_scope_id = ?
      limit 1
    `).get(taskSessionId, conversationScopeId) as TaskSessionBindingRow | undefined;
  }

  private assertDestinationAvailable(taskSessionId: string, conversationScopeId: string): void {
    const owner = this.database.sqlite.prepare(`
      select task_session_id from task_session_bindings
      where conversation_scope_id = ?
      limit 1
    `).get(conversationScopeId) as { task_session_id: string } | undefined;
    if (owner && owner.task_session_id !== taskSessionId) {
      throw new TaskSessionConflictError(
        "DESTINATION_OWNED",
        `Conversation ${conversationScopeId} already belongs to task session ${owner.task_session_id}.`,
      );
    }
  }
}

export function createTaskSessionStore(
  stateDir: string,
  now?: () => string,
): SqliteTaskSessionStore {
  return new SqliteTaskSessionStore(stateDir, now);
}

function normalizedConversation(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function rowToTaskSession(row: TaskSessionRow): TaskSessionRecord {
  return {
    id: row.id,
    workspaceSessionId: row.workspace_session_id,
    status: readTaskSessionStatus(row.status),
    currentConversationScopeId: row.current_conversation_scope_id ?? undefined,
    lineageVersion: row.lineage_version,
    nextEventSeq: row.next_event_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTaskSessionBinding(row: TaskSessionBindingRow): TaskSessionBindingRecord {
  return {
    taskSessionId: row.task_session_id,
    conversationScopeId: row.conversation_scope_id,
    state: readTaskSessionBindingState(row.state),
    generation: row.generation,
    boundAt: row.bound_at,
    supersededAt: row.superseded_at ?? undefined,
  };
}

function readTaskSessionStatus(value: string): TaskSessionStatus {
  if (value === "active" || value === "checkpointing" || value === "rebinding" || value === "degraded" || value === "closed") {
    return value;
  }
  throw new TaskSessionConflictError("CORRUPT_BINDING", `Invalid task-session status in storage: ${value}.`);
}

function readTaskSessionBindingState(value: string): TaskSessionBindingState {
  if (value === "current" || value === "superseded" || value === "abandoned") return value;
  throw new TaskSessionConflictError("CORRUPT_BINDING", `Invalid task-session binding state in storage: ${value}.`);
}
