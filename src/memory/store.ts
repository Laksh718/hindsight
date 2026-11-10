/**
 * Memory: conversations, their messages and the claim ledger.
 *
 * Why not SQLite or a vector DB? One user has at most a few thousand
 * messages. Holding them in memory and saving a snapshot is fast, needs no
 * native build step (`npm install` just works), and the saved JSON is
 * readable: you can open it and see exactly what the agent remembers.
 * Where the snapshot goes is a Persistence (file locally, Redis on Vercel).
 *
 * Writes are serialised through one promise chain, so they land in order.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Claim, Conversation, ConversationSummary, Message } from '../types.ts';
import { FilePersistence, type Persistence, type Snapshot } from './persistence.ts';

export class MemoryStore {
  private conversations = new Map<string, Conversation>();
  private writing: Promise<void> = Promise.resolve();
  private readonly persistence: Persistence;
  /** Bumped on every change, so derived indexes know when to rebuild. */
  revision = 0;

  /** A directory (stores data/memory.json there) or any Persistence. */
  constructor(where: string | Persistence) {
    this.persistence = typeof where === 'string' ? new FilePersistence(path.join(where, 'memory.json')) : where;
  }

  async load(): Promise<this> {
    const data = await this.persistence.load();
    for (const c of data?.conversations ?? []) this.conversations.set(c.id, { ...c, claims: c.claims ?? [] });
    return this;
  }

  private persist(): Promise<void> {
    this.revision++;
    const snapshot: Snapshot = { version: 1, conversations: [...this.conversations.values()] };
    this.writing = this.writing.then(() => this.persistence.save(snapshot));
    return this.writing;
  }

  /** Resolves once every pending write has landed. */
  flush(): Promise<void> {
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
