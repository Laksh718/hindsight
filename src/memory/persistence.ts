/**
 * Where memory lives. The store works on an in-memory snapshot and hands the
 * whole snapshot to one of these to keep it.
 *
 *   FilePersistence   local runs: data/memory.json, atomic writes
 *   RedisPersistence  hosted runs (Vercel): one key per visitor in Upstash
 *                     Redis, over its REST API, so no driver and no sockets
 *
 * One user's memory is small (kilobytes to a few MB), so whole-snapshot
 * reads and writes are simpler and safer than per-row updates.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Conversation } from '../types.ts';

export interface Snapshot {
  version: 1;
  conversations: Conversation[];
}

export interface Persistence {
  load(): Promise<Snapshot | null>;
  save(snapshot: Snapshot): Promise<void>;
}

export class FilePersistence implements Persistence {
  constructor(private readonly file: string) {}

  async load(): Promise<Snapshot | null> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      return JSON.parse(await readFile(this.file, 'utf8')) as Snapshot;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(snapshot: Snapshot): Promise<void> {
    // Write beside, then rename: a crash mid-write never leaves half a file.
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot, null, 1));
    await rename(tmp, this.file);
  }
}

export class RedisPersistence implements Persistence {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly key: string,
  ) {}

  private async command(args: unknown[]): Promise<unknown> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(8000),
    });
    const data = (await res.json()) as { result?: unknown; error?: string };
    if (!res.ok || data.error) throw new Error(`Redis: ${data.error ?? res.status}`);
    return data.result;
  }

  async load(): Promise<Snapshot | null> {
    const raw = await this.command(['GET', this.key]);
    return typeof raw === 'string' ? (JSON.parse(raw) as Snapshot) : null;
  }

  async save(snapshot: Snapshot): Promise<void> {
    // Memory that nobody touches for 90 days expires: hosted demo visitors come and go.
    await this.command(['SET', this.key, JSON.stringify(snapshot), 'EX', 90 * 86_400]);
  }
}

/** Nothing is kept beyond this process. Used only when no store is configured on a host. */
export class VolatilePersistence implements Persistence {
  private snapshot: Snapshot | null = null;
  async load() {
    return this.snapshot;
  }
  async save(s: Snapshot) {
    this.snapshot = s;
  }
}
