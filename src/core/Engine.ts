// src/core/Engine.ts
import type {ToolCall, StoredPatch, PatchResult, Message, Sources} from '../types';
import {AppConfig} from '../config/AppConfig';
import {StorageAdapter} from '../config/StorageAdapter';
import {LLMClient} from '../llm/LLMClient';
import {SemanticIndexer} from './SemanticIndexer';
import {AdaptiveProgressObserver} from '../utils/AdaptiveProgressObserver.js';
import {dedent} from "../utils/dedent";

export class HypoAssistantEngine {
    constructor(
        private config: AppConfig,
        private storage: StorageAdapter,
        private llm: LLMClient
    ) {
    }

    async run(userQuery: string, progress: AdaptiveProgressObserver, signal?: AbortSignal): Promise<PatchResult> {
        const engineFlow = progress.startFlow({steps: 3, stepTimeMs: 60_000});

        // === Шаг 1: Индексирование ===
        engineFlow.startStep('Indexing sources');
        const {originals, index: semanticIndex} = await this.indexSources(engineFlow, signal);

        console.group(`[HypoAssistant] 🚀 New request: "${userQuery}"`);

        // === Шаг 2: Поиск релевантных файлов ===
        engineFlow.startStep('Finding relevant files');
        const relevantIds = await this.findRelevantFiles(
            userQuery,
            semanticIndex,
            engineFlow,
            signal
        );
        console.log('📁 Relevant files:', relevantIds);

        // === Шаг 3: Генерация патча ===
        engineFlow.startStep('Patch generation');
        const {groupTitle, storedPatches} = await this.generatePatches(
            userQuery,
            originals,
            relevantIds,
            engineFlow,
            signal
        );

        if (storedPatches.length === 0) {
            throw new Error('No valid patches generated');
        }

        console.log('🏆 Generated group:', {groupTitle, patches: storedPatches});

        const diagnostics = this.storage.getDiagnostics();
        diagnostics.runs.push({
            timestamp: new Date().toISOString(),
            phase: 'final_tool_call',
            data: {groupTitle, patches: storedPatches}
        });
        this.storage.saveDiagnostics(diagnostics);

        console.groupEnd();

        return {
            message: groupTitle,
            patches: storedPatches,
            groupTitle
        };
    }

    private async indexSources(
        progress: AdaptiveProgressObserver,
        signal?: AbortSignal
    ): Promise<{ originals: Sources; index: Record<string, any> }> {
        return await new SemanticIndexer(this.config, this.storage, this.llm)
            .ensureIndex(progress, signal);
    }

    private async findRelevantFiles(
        userQuery: string,
        semanticIndex: Record<string, any>,
        progress: AdaptiveProgressObserver,
        signal?: AbortSignal
    ): Promise<string[]> {
        const activePatches = this.storage.getPatches().filter(p => p.enabled);
        const activePatchesSummary = activePatches.length > 0
            ? activePatches.map(p => `- ${p.title}`).join('\n')
            : 'None';

        const relevancePrompt: Message = {
            role: 'system',
            content: dedent`
                Project structure:
                ${JSON.stringify(semanticIndex, null, 2)}
                
                Currently active patches (already applied to the page):
                ${activePatchesSummary}
                
                Note: Applied patches are user-controlled and may be disabled at any time. Do not assume their effects are permanent.
                
                Return {"relevant": ["file_id"]}`
        };
        const userRelevanceMsg: Message = {role: 'user', content: userQuery};

        const relevanceRes = await this.llm.call(
            [relevancePrompt, userRelevanceMsg],
            'relevance',
            signal,
            undefined,
            progress
        );
        return (relevanceRes as any).relevant || ['HTML_DOC'];
    }

    private async generatePatches(
        userQuery: string,
        originals: Sources,
        relevantIds: string[],
        progress: AdaptiveProgressObserver,
        signal?: AbortSignal
    ): Promise<{ groupTitle: string; storedPatches: StoredPatch[] }> {

        const contextBlocks = relevantIds.map(id => {
            const src = originals[id];
            return src ? `[FILE: ${id}]\n${src.content}\n[/FILE]` : '';
        }).filter(Boolean).join('\n\n');

        const activePatches = this.storage.getPatches().filter(p => p.enabled);
        const activePatchesSummary = activePatches.length > 0
            ? activePatches.map(p => `- ${p.title}`).join('\n')
            : 'None';

        const patchPrompt: Message = {
            role: 'system',
            content: dedent`
                You are a precise frontend editor. Fulfill the user request by generating **one or more tools** in the correct order.

                Currently active patches (already applied to the page):
                ${activePatchesSummary}
                
                Note: Applied patches are user-controlled and may be disabled at any time. Do not assume their effects are permanent.
                - AVOID duplicating changes already listed in "Currently active patches".
                
                Return a JSON object with:
                {
                  "groupTitle": "Short summary of the entire change (max 80 characters)",
                  "patches": [
                    {
                      "tool": "setTextContent",
                      "selector": "CSS selector that uniquely identifies the target element (e.g. 'h1.ru-only', '#main-title')",
                      "text": "The new text content to set (plain text, no HTML)",
                      "title": "Short, human-readable description of this change (max 60 characters, e.g. 'Add 🦛 to heading')"
                    },
                    {
                      "tool": "setAttribute",
                      "selector": "CSS selector of the element",
                      "name": "name of the attribute to set (e.g. 'class', 'style', 'data-id')",
                      "value": "new attribute value",
                      "title": "Short description"
                    },
                    {
                      "tool": "insertAdjacentHTML",
                      "selector": "CSS selector of the target element",
                      "position": "one of: 'beforebegin', 'afterbegin', 'beforeend', 'afterend'",
                      "html": "Safe, minimal HTML string to insert",
                      "title": "Short description"
                    },
                    {
                      "tool": "addStyleRule",
                      "selector": "CSS selector to apply styles to (e.g. ':root', '.card')",
                      "style": "Valid CSS declaration block (e.g. 'background: pink; color: white')",
                      "title": "Short description"
                    },
                    {
                      "tool": "removeElement",
                      "selector": "CSS selector of the element to remove",
                      "title": "Short description"
                    },
                    {
                      "tool": "wrapElement",
                      "selector": "CSS selector of the element to wrap",
                      "wrapperTag": "HTML tag name for the wrapper (e.g. 'div', 'span')",
                      "wrapperClass": "optional CSS class for the wrapper",
                      "title": "Short description"
                    },
                    {
                      "tool": "applyTextPatch",
                      "file": "file_id (e.g. 'HTML_DOC', 'inline-script-0')",
                      "from": "exact substring present in the original file content",
                      "to": "replacement substring",
                      "title": "Short description"
                    }
                  ]
                }
                
                Critical Rules:
                - ✅ **NEVER use \`applyTextPatch\` for styles, text content, or standard HTML elements**.
                - ✅ **For CSS changes → ALWAYS use \`addStyleRule\`**.
                - ✅ **For text changes → ALWAYS use \`setTextContent\` or \`insertAdjacentHTML\`**.
                - ✅ **For attribute changes → ALWAYS use \`setAttribute\`**.
                - ⚠️ **Only use \`applyTextPatch\` as a last resort** when:
                    - the target is inside a \`<script>\` or \`<template>\` tag,
                    - and no DOM selector can be used to modify it incrementally.
                - 🚫 **Never use \`applyTextPatch\` on \`HTML_DOC\` unless it's the only way to fix broken markup that cannot be addressed via DOM APIs**.
                - Order matters: apply patches in the exact sequence provided.
                - Every patch must have a concise, meaningful "title" (max 60 characters).
                - "groupTitle" must be ≤ 80 characters and describe the whole intent.
                - NEVER generate JavaScript code or use eval.
                - Return ONLY valid JSON. No markdown, no explanation.`
        };

        const userPatchMsg: Message = {
            role: 'user',
            content: `Context:\n${contextBlocks}\n\nUser request: ${userQuery}`
        };

        const patchRes = await this.llm.call(
            [patchPrompt, userPatchMsg],
            'patch',
            signal,
            undefined,
            progress
        ) as any;

        let groupTitle = 'Untitled change';
        if (typeof patchRes.groupTitle === 'string') {
            groupTitle = patchRes.groupTitle.substring(0, 80);
        }

        const rawPatches = Array.isArray(patchRes.patches) ? patchRes.patches : [patchRes];
        const storedPatches = this.createStoredPatches(rawPatches, relevantIds);

        return {groupTitle, storedPatches};
    }

    private createStoredPatches(rawPatches: any[], relevantIds: string[]): StoredPatch[] {
        const storedPatches: StoredPatch[] = [];

        for (const p of rawPatches) {
            if (!p.tool || !p.title) continue;

            let toolCall: ToolCall | null = null;
            let title = p.title.substring(0, 60);

            switch (p.tool) {
                case 'setTextContent':
                    if (p.selector && p.text !== undefined) {
                        toolCall = {tool: 'setTextContent', selector: p.selector, text: p.text};
                    }
                    break;
                case 'setAttribute':
                    if (p.selector && p.name && p.value !== undefined) {
                        toolCall = {tool: 'setAttribute', selector: p.selector, name: p.name, value: p.value};
                    }
                    break;
                case 'insertAdjacentHTML':
                    if (p.selector && p.position && p.html !== undefined) {
                        const pos = p.position;
                        if (['beforebegin', 'afterbegin', 'beforeend', 'afterend'].includes(pos)) {
                            toolCall = {
                                tool: 'insertAdjacentHTML',
                                selector: p.selector,
                                position: pos as any,
                                html: p.html
                            };
                        }
                    }
                    break;
                case 'addStyleRule':
                    if (p.selector && p.style !== undefined) {
                        toolCall = {tool: 'addStyleRule', selector: p.selector, style: p.style};
                    }
                    break;
                case 'removeElement':
                    if (p.selector) {
                        toolCall = {tool: 'removeElement', selector: p.selector};
                    }
                    break;
                case 'wrapElement':
                    if (p.selector && p.wrapperTag) {
                        toolCall = {
                            tool: 'wrapElement',
                            selector: p.selector,
                            wrapperTag: p.wrapperTag,
                            wrapperClass: p.wrapperClass
                        };
                    }
                    break;
                case 'applyTextPatch':
                    if (p.file && p.from && p.to) {
                        toolCall = {tool: 'applyTextPatch', file: p.file, from: p.from, to: p.to};
                    }
                    break;
            }

            if (toolCall) {
                storedPatches.push({
                    id: crypto.randomUUID(),
                    toolCall,
                    dependsOn: relevantIds,
                    enabled: false,
                    createdAt: new Date().toISOString(),
                    title
                });
            }
        }

        return storedPatches;
    }
}