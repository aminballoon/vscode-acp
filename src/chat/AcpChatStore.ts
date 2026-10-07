import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { logError } from '../utils/Logger';

export interface StoredTurn {
  prompt: string;
  /** Agent reply as markdown. */
  response: string;
  /** Titles of the tool calls made during the turn. */
  tools: string[];
  at: number;
}

export interface StoredChat {
  /** Path of the chat session resource (`acp:/<id>`), without the leading slash. */
  id: string;
  label: string;
  agentName?: string;
  /** ACP session of the agent, used to restore its context with session/load. */
  acpSessionId?: string;
  /** Picker selections (agent, model, effort, ...) by option group id. */
  selections: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  turns: StoredTurn[];
}

/**
 * Persists ACP chat sessions (one JSON file per chat) so they show up in the
 * session list and keep their history across restarts.
 */
export class AcpChatStore {
  private chats = new Map<string, StoredChat>();
  private loaded?: Promise<void>;

  constructor(private readonly dir: string) {}

  /** Load all chats once; later calls reuse the in-memory copy. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      let names: string[] = [];
      try {
        names = (await fs.readdir(this.dir)).filter(n => n.endsWith('.json'));
      } catch {
        return; // nothing stored yet
      }
      await Promise.all(names.map(async name => {
        try {
          const chat = JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')) as StoredChat;
          if (chat?.id) { this.chats.set(chat.id, chat); }
        } catch (e) {
          logError(`ACP chat store: unreadable ${name}`, e);
        }
      }));
    })();
    return this.loaded;
  }

  list(): StoredChat[] {
    return [...this.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): StoredChat | undefined {
    return this.chats.get(id);
  }

  /** Get the chat, creating an empty one when it does not exist yet. */
  ensure(id: string, label: string): StoredChat {
    let chat = this.chats.get(id);
    if (!chat) {
      const now = Date.now();
      chat = { id, label, selections: {}, createdAt: now, updatedAt: now, turns: [] };
      this.chats.set(id, chat);
    }
    return chat;
  }

  async save(chat: StoredChat): Promise<void> {
    chat.updatedAt = Date.now();
    this.chats.set(chat.id, chat);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file(chat.id), JSON.stringify(chat, null, 1));
  }

  async delete(id: string): Promise<void> {
    this.chats.delete(id);
    await fs.rm(this.file(id), { force: true });
  }

  private file(id: string): string {
    return path.join(this.dir, `${id.replace(/[^\w-]/g, '_')}.json`);
  }
}
