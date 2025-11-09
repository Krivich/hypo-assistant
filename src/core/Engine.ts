// ТЕЗИС: Движок ничего не знает о UI — он принимает запрос и возвращает патч.
// ТЕЗИС: Отмена запроса работает на всём пути: от UI до fetch.

import type { ToolCall, PatchResult } from '../types';
import { AppConfig } from '../config/AppConfig';
import { StorageAdapter } from '../config/StorageAdapter';
import { LLMClient } from '../llm/LLMClient';
import { SemanticIndexer } from './SemanticIndexer';

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
            content: `You are a precise frontend editor. Fulfill the user request by choosing **one** of the following tools:

{
  "tool": "setTextContent",
  "selector": "CSS selector (must be unique and safe)",
  "text": "new text content"
}

{
  "tool": "setAttribute",
  "selector": "CSS selector",
  "name": "attribute name",
  "value": "attribute value"
}

{
  "tool": "insertAdjacentHTML",
  "selector": "CSS selector of target element",
  "position": "beforebegin | afterbegin | beforeend | afterend",
  "html": "safe HTML string"
}

{
  "tool": "addStyleRule",
  "selector": "CSS selector",
  "style": "CSS rules, e.g. 'color: red; font-weight: bold'"
}

{
  "tool": "removeElement",
  "selector": "CSS selector"
}

{
  "tool": "wrapElement",
  "selector": "CSS selector of element to wrap",
  "wrapperTag": "HTML tag name, e.g. 'div'",
  "wrapperClass": "optional CSS class for wrapper"
}

{
  "tool": "applyTextPatch",
  "file": "file_id (e.g. 'HTML_DOC')",
  "from": "exact substring in original file content",
  "to": "replacement substring"
}

Rules:
- Prefer non-destructive, incremental DOM changes.
- NEVER generate JavaScript code or use eval.
- Ensure selector uniquely identifies the target.
- Return ONLY valid JSON. No markdown, no explanation.
`
        };
        const userMsg = { role: 'user', content: `Context:\n${contextBlocks}\n\nUser request: ${userQuery}` };
        const patchRes = await this.llm.call([patchPrompt, userMsg], 'patch', signal) as any;

        let toolCall: ToolCall;
        if (patchRes.tool === 'setTextContent') {
            toolCall = { tool: 'setTextContent', selector: patchRes.selector, text: patchRes.text };
        } else if (patchRes.tool === 'setAttribute') {
            toolCall = { tool: 'setAttribute', selector: patchRes.selector, name: patchRes.name, value: patchRes.value };
        } else if (patchRes.tool === 'insertAdjacentHTML') {
            toolCall = { tool: 'insertAdjacentHTML', selector: patchRes.selector, position: patchRes.position, html: patchRes.html };
        } else if (patchRes.tool === 'addStyleRule') {
            toolCall = { tool: 'addStyleRule', selector: patchRes.selector, style: patchRes.style };
        } else if (patchRes.tool === 'removeElement') {
            toolCall = { tool: 'removeElement', selector: patchRes.selector };
        } else if (patchRes.tool === 'wrapElement') {
            toolCall = { tool: 'wrapElement', selector: patchRes.selector, wrapperTag: patchRes.wrapperTag, wrapperClass: patchRes.wrapperClass };
        } else if (patchRes.tool === 'applyTextPatch') {
            toolCall = { tool: 'applyTextPatch', file: patchRes.file, from: patchRes.from, to: patchRes.to };
        } else {
            throw new Error('Invalid tool response from LLM');
        }

        console.log('🏆 Final tool call:', toolCall);

        // Save diagnostics
        const diagnostics = this.storage.getDiagnostics();
        diagnostics.runs.push({
            timestamp: new Date().toISOString(),
            phase: 'final_tool_call',
            data: toolCall
        });
        this.storage.saveDiagnostics(diagnostics);

        console.groupEnd();

        return {
            message: 'Patch generated via tool-based LLM request.',
            patches: [toolCall]
        };
    }
}