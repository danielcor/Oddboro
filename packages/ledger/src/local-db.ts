// The office's own Postgres, when .env names no other: PGlite (Postgres built
// to WebAssembly) running inside the office server, with its files in
// ~/.oddboro/db. Every other process (each staff run's tool server, the
// scripts) reaches it like any Postgres, through the DATABASE_URL db.ts sets:
// on a Mac and Linux a socket in the private office home, on Windows a port
// on 127.0.0.1 (`LOCAL_DATABASE_SOCKET`). Nothing to install.
//
// PGlite is one session. The socket server shares it between connections, and
// the office server's own LISTEN lives on that one session too. Socket traffic
// comes back as raw protocol bytes that PGlite never parses for itself, so a
// NOTIFY written by another process would not reach a listener here. This file
// reads the NotificationResponse messages out of that stream and hands them on.
//
// The socket server also queues each protocol message on its own, so another
// connection's statement could land between one connection's Parse and Bind
// and the session would lose the unnamed statement. oneAtATime keeps a
// connection in charge until its Sync, or until its transaction ends.
import { mkdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { backUpForNewVersion } from './backup.ts';
import { applyStagedRestore } from './office-backup.ts';
import { LOCAL_DATABASE_DIR, LOCAL_DATABASE_PORT, LOCAL_DATABASE_SOCKET } from './db.ts';
import { currentPlatform } from './platform.ts';

type Listener = (channel: string, payload: string) => void;
/** Closes the socket and the database. Only a test needs it: the office's own ends with its process. */
type Stop = () => Promise<void>;
type Local = { ready: Promise<Stop>; listeners: Set<Listener>; db?: PGlite };
const g = globalThis as unknown as { localDatabase?: Local };

/** Start the local database once per process, even when Vite reloads this module. */
export function startLocalDatabase(): Promise<Stop> {
  g.localDatabase ??= { ready: open(), listeners: new Set() };
  return g.localDatabase.ready;
}

/**
 * The database as PGlite's own tar of its folder, for a backup
 * (office-backup.ts). PGlite takes it between two statements, so it is whole
 * while the office runs.
 */
export async function dumpLocalDatabase(): Promise<Buffer> {
  await g.localDatabase?.ready;
  const db = g.localDatabase?.db;
  if (!db) throw new Error("The office's own database is not running.");
  return Buffer.from(await (await db.dumpDataDir('none')).arrayBuffer());
}

/** Hear NOTIFY on a channel, from any process. */
export function listenLocal(channel: string, fn: (payload: string) => void): void {
  g.localDatabase?.listeners.add((c, p) => {
    if (c === channel) fn(p);
  });
}

async function open(): Promise<Stop> {
  // Before the files open: another office on this home must not open them too.
  if (LOCAL_DATABASE_SOCKET) await socketFree(LOCAL_DATABASE_SOCKET);
  // A backup the owner chose to restore goes in while the files are closed.
  applyStagedRestore();
  // A new version's first start copies the database aside before it opens it.
  backUpForNewVersion();
  mkdirSync(LOCAL_DATABASE_DIR, { recursive: true });
  const db = await PGlite.create(LOCAL_DATABASE_DIR, { extensions: { vector } });
  g.localDatabase!.db = db;
  await db.exec('create extension if not exists vector');
  // Postgres only sends a notification to a session that asked for it.
  await db.exec('listen office');
  hearNotifications(db);
  const server = new PGLiteSocketServer({
    db,
    ...(LOCAL_DATABASE_SOCKET
      ? { path: LOCAL_DATABASE_SOCKET }
      : { port: LOCAL_DATABASE_PORT, host: '127.0.0.1' }),
    maxConnections: 64
  });
  oneAtATime(server, db);
  await server.start();
  return async () => {
    await server.stop();
    await db.close();
  };
}

// The longest socket path the system takes: 104 bytes on a Mac and 108 on
// Linux, the last one a NUL. Longer, and Node's listen fails with only EINVAL.
const SOCKET_MAX = currentPlatform() === 'darwin' ? 103 : 107;

/**
 * Make sure the socket's path is free. A socket an office that crashed left
 * behind goes, since nothing answers on it. One that answers belongs to
 * another office running from this home, which this one must not join.
 */
async function socketFree(path: string): Promise<void> {
  const bytes = Buffer.byteLength(path);
  if (bytes > SOCKET_MAX)
    throw new Error(
      `The office's database socket would be ${path}, which is ${bytes} bytes. This system takes at most ${SOCKET_MAX}. Move the office to a folder with a shorter path, and set ODDBORO_HOME to it.`
    );
  const answers = await new Promise<boolean>((done) => {
    const s = connect(path, () => {
      s.destroy();
      done(true);
    });
    s.on('error', () => done(false));
  });
  if (answers) throw new Error(`Another office is already running from ${dirname(path)}.`);
  rmSync(path, { force: true });
}

// pglite-socket 0.2.16's queue, which the version pin in package.json holds still.
type Item = {
  handlerId: number;
  message: Uint8Array;
  resolve: (bytes: number) => void;
  reject: (e: unknown) => void;
  onData: (data: Uint8Array) => void;
};
type Queue = {
  queue: Item[];
  processing: boolean;
  lastHandlerId: number | null;
  processQueue: () => Promise<void>;
  clearQueueForHandler: (id: number) => void;
};
// Parse, Bind, Describe, Execute, Close and Flush: the rest of the statement follows.
const MID_STATEMENT = new Set([...'PBDECH'].map((c) => c.charCodeAt(0)));

function oneAtATime(server: PGLiteSocketServer, db: PGlite): void {
  const q = (server as unknown as { queryQueue: Queue }).queryQueue;
  let owner: number | null = null;
  q.processQueue = async () => {
    if (q.processing) return;
    q.processing = true;
    while (q.queue.length) {
      const at = owner === null ? 0 : q.queue.findIndex((i) => i.handlerId === owner);
      // The owner has more to send; the others wait for it.
      if (at < 0) break;
      const [item] = q.queue.splice(at, 1);
      let bytes = 0;
      try {
        await db.runExclusive(() =>
          db.execProtocolRawStream(item.message, {
            onRawData: (d) => {
              bytes += d.length;
              item.onData(d);
            }
          })
        );
      } catch (e) {
        owner = null;
        item.reject(e);
        continue;
      }
      q.lastHandlerId = item.handlerId;
      owner = MID_STATEMENT.has(item.message[0]) || db.isInTransaction() ? item.handlerId : null;
      item.resolve(bytes);
    }
    q.processing = false;
  };
  // A connection that drops mid-statement hands the session back.
  const clear = q.clearQueueForHandler.bind(q);
  q.clearQueueForHandler = (id) => {
    if (owner === id) owner = null;
    clear(id);
  };
}

const decoder = new TextDecoder();

function hearNotifications(db: PGlite): void {
  const raw = db.execProtocolRawStream.bind(db);
  db.execProtocolRawStream = (message, opts) => {
    let held = new Uint8Array(0);
    const onRawData = (chunk: Uint8Array) => {
      opts?.onRawData?.(chunk);
      const all = new Uint8Array(held.length + chunk.length);
      all.set(held);
      all.set(chunk, held.length);
      let at = 0;
      // Each message is a type byte, then a length that counts itself.
      while (all.length - at >= 5) {
        const length = new DataView(all.buffer, all.byteOffset + at + 1, 4).getInt32(0);
        if (all.length - at < 1 + length) break;
        // 'A' is NotificationResponse: the sender's pid, the channel, the payload.
        if (all[at] === 0x41) {
          const body = all.subarray(at + 9, at + 1 + length);
          const end = body.indexOf(0);
          const channel = decoder.decode(body.subarray(0, end));
          const payload = decoder.decode(body.subarray(end + 1, body.indexOf(0, end + 1)));
          g.localDatabase?.listeners.forEach((l) => l(channel, payload));
        }
        at += 1 + length;
      }
      held = all.slice(at);
    };
    return raw(message, { ...opts, onRawData });
  };
}
