/**
 * Durable memory: one JSON file.
 *
 * Why not SQLite or a vector DB? This is a single-user agent with, at most, a
 * few thousand messages. A JSON file loads in milliseconds, needs no native
 * build step (`npm install` just works on every machine), and you can open it
 * and read exactly what the agent remembers. The store is a small interface,
 * so swapping in Postgres later touches this file only.
 *
 * Writes go to a temp file and are renamed into place, so a crash mid-write
 * never corrupts memory. Writes are serialised through one promise chain.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Claim, Conversation, ConversationSummary, Message } from '../types.ts';

interface FileShape {
  version: 1;
  conversations: Conversation[];
}

export class MemoryStore {
  private conversations = new Map<string, Conversation>();
  private writing: Promise<void> = Promise.resolve();
  private readonly file: string;
  /** Bumped on every change, so derived indexes know when to rebuild. */
  revision = 0;

  constructor(dir: string) {
    this.file = path.join(dir, 'memory.json');
  }

  async load(): Promise<this> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as FileShape;
      for (const c of data.conversations ?? []) this.conversations.set(c.id, { ...c, claims: c.claims ?? [] });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return this;
  }

  private persist(): Promise<void> {
    this.revision++;
    const snapshot: FileShape = { version: 1, conversations: [...this.conversations.values()] };
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot, null, 1));
      await rename(tmp, this.file);
    });
    return this.writing;
  }

  /** All conversations, newest activity first. */
  all(): Conversation[] {
    return [...this.conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  list(): ConversationSummary[] {
    return this.all().map((c) => ({
      id: c.id,
      title: c.title,
      summary: c.summary,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      simulated: c.simulated,
      messageCount: c.messages.length,
      claimCount: c.claims.length,
    }));
  }

  get(id: string): Conversation | undefined {
    return this.conversations.get(id);
  }

  async create(init: { at: string; tz: string; simulated?: boolean }): Promise<Conversation> {
    const c: Conversation = {
      id: randomUUID(),
      title: '',
      summary: '',
      createdAt: init.at,
      updatedAt: init.at,
      tz: init.tz,
      simulated: init.simulated || undefined,
      messages: [],
      claims: [],
    };
    this.conversations.set(c.id, c);
    await this.persist();
    return c;
  }

  async addMessage(conversationId: string, message: Omit<Message, 'id'>): Promise<Message> {
    const c = this.mustGet(conversationId);
    const m: Message = { id: randomUUID(), ...message };
    c.messages.push(m);
    if (m.at > c.updatedAt) c.updatedAt = m.at;
    await this.persist();
    return m;
  }

  async annotate(conversationId: string, patch: { title?: string; summary?: string; claims?: Claim[] }): Promise<void> {
    const c = this.mustGet(conversationId);
    if (patch.title) c.title = patch.title;
    if (patch.summary) c.summary = patch.summary;
    if (patch.claims?.length) c.claims.push(...patch.claims);
    await this.persist();
  }

  async delete(id: string): Promise<boolean> {
    const existed = this.conversations.delete(id);
    if (existed) await this.persist();
    return existed;
  }

  private mustGet(id: string): Conversation {
    const c = this.conversations.get(id);
    if (!c) throw new Error(`No conversation ${id}`);
    return c;
  }
}
