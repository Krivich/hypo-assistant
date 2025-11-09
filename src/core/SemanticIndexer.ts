// ТЕЗИС: Индекс строится только для изменённых или неиндексированных файлов — оптимизация скорости.
// ТЕЗИС: Неудачная индексация удаляет запись — мы не храним фолбэки (они вводят в заблуждение).

import type { Sources } from '../types';
import { AppConfig } from '../config/AppConfig';
import { StorageAdapter } from '../config/StorageAdapter';
import { LLMClient } from '../llm/LLMClient';
import { collectOriginalSources } from './SourceCollector';

function isFallbackIndex(entry: any): boolean {
  return (
    entry.purpose === 'One-sentence role' ||
    entry.purpose === 'Unindexed html file' ||
    entry.key_entities.length === 0 ||
    (entry.key_entities.length === 3 &&
      entry.key_entities.every((k: string) => ['functions', 'classes', 'CSS classes'].includes(k)))
  );
}

export class SemanticIndexer {
  constructor(
    private config: AppConfig,
    private storage: StorageAdapter,
    private llm: LLMClient
  ) {}

  async ensureIndex(): Promise<{ originals: Sources; index: Record<string, any> }> {
    let originals = this.storage.getOriginals();
    let semanticIndex = this.storage.getSemanticIndex();
    if (!originals) {
      originals = await collectOriginalSources();
      this.storage.saveOriginals(originals);
      semanticIndex = {};
    }
    if (!semanticIndex) semanticIndex = {};

    let needsSave = false;

    for (const [fileId, meta] of Object.entries(originals)) {
      const stored = semanticIndex[fileId];
      if (!stored || stored.hash !== meta.hash || isFallbackIndex(stored)) {
        try {
          const systemPrompt = {
            role: 'system',
            content: `You are a precise code analyst. Analyze the following ${meta.type} file and return ONLY a JSON object with:
{
  "purpose": "Exactly one sentence. What this file does in the app?",
  "key_entities": [
    "List every important CSS class (e.g. '.chat-messages', '.send-btn'), function name, variable, or event listener.",
    "Do NOT use generic terms like 'CSS classes' or 'functions'. Be specific."
  ],
  "dependencies": [
    "List file IDs (e.g. 'inline-script-3', 'linked-css-1') that this file likely interacts with.",
    "If unsure, leave empty array."
  ]
}
Rules:
- Be exhaustive in key_entities.
- Never summarize or generalize.
- If the file is empty or trivial, set purpose to "Trivial or empty file".
- Return ONLY valid JSON. No markdown, no explanation.`
          };
          const userPrompt = {
            role: 'user',
            content: `[FILE: ${fileId}]\n${meta.content}`
          };
          const summary = await this.llm.call([systemPrompt, userPrompt], `indexing:${fileId}`);
          semanticIndex[fileId] = { ...summary, hash: meta.hash };
          needsSave = true;
        } catch (err) {
          console.warn(`Failed to index ${fileId}:`, (err as Error).message);
          delete semanticIndex[fileId];
          needsSave = true;
        }
      }
    }

    if (needsSave) {
      this.storage.saveSemanticIndex(semanticIndex);
    }

    return { originals, index: semanticIndex };
  }
}
