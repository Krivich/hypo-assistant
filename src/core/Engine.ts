// ТЕЗИС: Движок ничего не знает о UI — он принимает запрос и возвращает патч.
// ТЕЗИС: Отмена запроса работает на всём пути: от UI до fetch.

import type { Patch } from '../types';
import { AppConfig } from '../config/AppConfig';
import { StorageAdapter } from '../config/StorageAdapter';
import { LLMClient } from '../llm/LLMClient';
import { SemanticIndexer } from './SemanticIndexer';

export interface PatchResult {
  message: string;
  patches: Patch[];
}

export class HypoAssistantEngine {
  constructor(
    private config: AppConfig,
    private storage: StorageAdapter,
    private llm: LLMClient
  ) {}

  async run(userQuery: string, signal?: AbortSignal): Promise<PatchResult> {
    const { originals, index: semanticIndex } = await new SemanticIndexer(this.config, this.storage, this.llm).ensureIndex();

    console.group(`[HypoAssistant] 🚀 New request: "${userQuery}"`);

    const relevancePrompt = {
      role: 'system',
      content: `Project structure:\n${JSON.stringify(semanticIndex, null, 2)}\nReturn {"relevant": ["file_id"]}`
    };
    const relevanceRes = await this.llm.call([relevancePrompt, { role: 'user', content: userQuery }], 'relevance', signal);
    const relevantIds: string[] = (relevanceRes as any).relevant || ['HTML_DOC'];
    console.log('📁 Relevant files:', relevantIds);

    const contextBlocks = relevantIds.map(id => {
      const src = originals[id];
      return src ? `[FILE: ${id}]\n${src.content}\n[/FILE]` : '';
    }).filter(Boolean).join('\n\n');

    const patchPrompt = {
      role: 'system',
      content: `Generate a minimal, safe patch that fulfills the user request.
Return a JSON object with:
{
  "file": "file_id",
  "from": "exact substring to replace",
  "to": "replacement content"
}
Rules:
- NEVER use innerHTML.
- The "from" string must appear exactly in the provided file.
- Be minimal and surgical.
- Return ONLY valid JSON. No markdown, no explanation.`
    };
    const userMsg = { role: 'user', content: `Context:\n${contextBlocks}\n\nUser request: ${userQuery}` };
    const patchRes = await this.llm.call([patchPrompt, userMsg], 'patch', signal) as any;

    const finalPatch: Patch = {
      file: patchRes.file || relevantIds[0],
      from: patchRes.from,
      to: patchRes.to
    };

    console.log('🏆 Final patch:', finalPatch);

    // Save diagnostics
    const diagnostics = this.storage.getDiagnostics();
    diagnostics.runs.push({
      timestamp: new Date().toISOString(),
      phase: 'final_patch',
      data: finalPatch
    });
    this.storage.saveDiagnostics(diagnostics);

    console.groupEnd();

    return {
      message: 'Patch generated via direct LLM request.',
      patches: [finalPatch]
    };
  }
}
