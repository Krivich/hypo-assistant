// src/core/SemanticIndexer.ts
// ТЕЗИС: Индекс строится только для изменённых или неиндексированных файлов — оптимизация скорости.
// ТЕЗИС: Неудачная индексация удаляет запись — мы не храним фолбэки (они вводят в заблуждение).
// ТЕЗИС: При изменении чанка — валидация патчей делегируется LLM, а не жёстким правилам.
// ТЕЗИС: Все ресурсы HypoAssistant (разметка, стили, скрипты) помечаются атрибутом data-hypo-ignore при инжекте и исключаются из семантического индекса — они не являются частью целевого сайта.

import type { Sources, Message, StoredPatch } from '../types';
import { AppConfig } from '../config/AppConfig';
import { StorageAdapter } from '../config/StorageAdapter';
import { LLMClient } from '../llm/LLMClient';
import { collectOriginalSources } from './SourceCollector';
import { AdaptiveProgressObserver } from '../utils/AdaptiveProgressObserver.js';
import {dedent} from "../utils/dedent";

// === КИРПИЧИ ПРОМПТОВ ===

const CORE_INSTRUCTIONS = `
You are generating a single relevance record for a live code editing system.
This record represents one file as a whole — do not split it into parts.
The system uses these records to select files that contain elements the user might want to modify, replace, or update via code changes.
Later, if selected, the entire file content will be provided to generate a precise patch.
`;

const HTML_SPECIFIC = `
Focus on:
- Purpose: one sentence — what does this page do for the user?
- Structure: key interactive or visual zones (e.g. 'theme switcher', 'floating chat panel').
- Identifiers: CSS classes, IDs, DOM queries, event bindings that can be targeted.
- If the HTML appears to be a skeleton (e.g. contains placeholders, lacks real text), explicitly note: "This is likely a server-rendered skeleton; real content may be hydrated from a data script."
- Mention visible text only if it uniquely identifies a section (e.g. headline phrase, product name).
Avoid generic layout terms like 'container', 'wrapper', or 'div'.
`;

const JS_SPECIFIC = `
Focus on:
- Purpose: one sentence — what does this script do?
- If it contains structured data (e.g. app state, UI hydration payload, or a JSON-like object with entities like posts, users, products), describe its semantic content (e.g. "list of blog posts") and note: "This block hydrates UI elements in the HTML document."
- If it contains logic (functions, event listeners, DOM mutations), list: global variables, functions, DOM queries, event bindings.
- Do not assume it is executable logic if it only exports or declares data.
Avoid describing built-in APIs unless they define core behavior.
`;

const CSS_SPECIFIC = `
Focus on:
- Purpose: one sentence — what does this stylesheet control?
- Key entities: CSS variables (e.g. '--primary'), critical selectors (e.g. '.hero-title'), media queries, and language-specific rules.
Avoid listing every minor rule; focus on what affects layout, theming, or interactivity.
`;

const RESPONSE_FORMAT = `
Return ONLY a JSON object with:
{
  "purpose": "Exactly one sentence.",
  "key_entities": ["specific, actionable identifiers..."],
  "dependencies": ["file IDs this file interacts with..."]
}
`;

const STRICT_RULES = `
Rules:
- Be concise, concrete, and focused on what can be changed or is unique.
- Never summarize or generalize.
- If the file is empty or trivial, set purpose to "Trivial or empty file".
- Return ONLY valid JSON. No markdown, no explanation.
`;

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

function isFallbackIndex(entry: any): boolean {
    return (
        entry?.purpose === 'One-sentence role' ||
        entry?.purpose === 'Unindexed html file' ||
        !Array.isArray(entry?.key_entities) ||
        (Array.isArray(entry?.key_entities) &&
            entry.key_entities.length === 3 &&
            entry.key_entities.every((k: string) => ['functions', 'classes', 'CSS classes'].includes(k)))
    );
}

// === ОСНОВНОЙ КЛАСС ===

export class SemanticIndexer {
    constructor(
        private config: AppConfig,
        private storage: StorageAdapter,
        private llm: LLMClient
    ) {}

    // ТЕЗИС: Валидация и переиндексация выполняются только для реально изменившихся чанков.
    // ТЕЗИС: Пользовательские патчи сохраняются, если LLM подтверждает их валидность.

    private async validateAndReindexChunk(
        fileId: string,
        currentMeta: { type: string; content: string; hash: string },
        oldIndexEntry: any,
        relevantPatches: StoredPatch[],
        progress: AdaptiveProgressObserver,
        signal?: AbortSignal
    ): Promise<{ newIndex: any; validatedPatches: { id: string; valid: boolean }[] }> {
        // Формируем ТОЛЬКО специфичные инструкции для типа файла
        let fileSpecificInstructions = '';
        if (currentMeta.type === 'html') {
            fileSpecificInstructions = HTML_SPECIFIC;
        } else if (currentMeta.type === 'js') {
            fileSpecificInstructions = JS_SPECIFIC;
        } else if (currentMeta.type === 'css') {
            fileSpecificInstructions = CSS_SPECIFIC;
        } else {
            fileSpecificInstructions = dedent`
                Focus on the semantic meaning and structure of the content.
            `;
        }

        // Теперь включаем специфичные инструкции внутрь основного validationPrompt
        const validationPrompt: Message = {
            role: 'system',
            content: dedent`${CORE_INSTRUCTIONS} ${fileSpecificInstructions} ${RESPONSE_FORMAT} ${STRICT_RULES} The content of file "${fileId}" has changed.
                Old index entry:
                ${JSON.stringify(oldIndexEntry, null, 2)}
                
                Active patches that depend on this file:
                ${JSON.stringify(relevantPatches, null, 2)}
                
                Please:
                1. Generate a new index for this file (same format as before, adhering to the instructions above for ${currentMeta.type} files).
                2. For each patch, decide if it is still valid (can be applied to the new content).
                Return ONLY valid JSON:
                {
                  "newIndex": { "purpose": "...", "key_entities": [...], "dependencies": [...] },
                  "validatedPatches": [
                    { "id": "patch-id-1", "valid": true|false }
                  ]
                }`
        };

        const userPrompt: Message = {
            role: 'user',
            content: `[FILE: ${fileId}]\n${currentMeta.content}`
        };

        const response = await this.llm.call(
            [validationPrompt, userPrompt],
            `validate_reindex:${fileId}`,
            signal,
            undefined,
            progress
        );
        return response as any;
    }

    async ensureIndex(progress: AdaptiveProgressObserver, signal?: AbortSignal): Promise<{ originals: Sources; index: Record<string, any> }> {
        let originals = this.storage.getOriginals();
        let semanticIndex = this.storage.getSemanticIndex();
        if (!originals) {
            originals = await collectOriginalSources();
            this.storage.saveOriginals(originals);
            semanticIndex = {};
        }
        if (!semanticIndex) semanticIndex = {};

        const fileIds = Object.keys(originals);
        const indexerFlow = progress.startFlow({ steps: fileIds.length });
        let needsSave = false;

        for (const fileId of fileIds) {
            const meta = originals[fileId];
            const stored = semanticIndex[fileId];
            const storedHash = typeof stored === 'object' && stored !== null && 'hash' in stored
                ? stored.hash
                : undefined;

            indexerFlow.startStep(`File ${fileId}`);
            if (!stored || storedHash !== meta.hash || isFallbackIndex(stored)) {
                try {
                    if (stored && storedHash !== meta.hash) {
                        const allPatches = this.storage.getPatchGroups().flatMap(g => g.patches);
                        const relevantPatches = allPatches.filter(p => p.dependsOn.includes(fileId));
                        const result = await this.validateAndReindexChunk(
                            fileId, meta, stored, relevantPatches,
                            indexerFlow,
                            signal
                        );
                        semanticIndex[fileId] = { ...result.newIndex, hash: meta.hash };
                        if (result.validatedPatches?.length) {
                            const validMap = new Map(result.validatedPatches.map(v => [v.id, v.valid]));
                            const updatedPatches = allPatches.map(p =>
                                validMap.has(p.id) ? { ...p, enabled: validMap.get(p.id) === true && p.enabled } : p
                            );
                            // Сохраняем патчи в виде групп — преобразуем обратно
                            const existingGroups = this.storage.getPatchGroups();
                            const updatedGroups = existingGroups.map(group => ({
                                ...group,
                                patches: group.patches.map(p =>
                                    validMap.has(p.id) ? updatedPatches.find(pp => pp.id === p.id)! : p
                                )
                            }));
                            this.storage.savePatchGroups(updatedGroups);
                        }
                    } else {
                        let instructions = '';
                        if (meta.type === 'html') instructions = HTML_SPECIFIC;
                        else if (meta.type === 'js') instructions = JS_SPECIFIC;
                        else if (meta.type === 'css') instructions = CSS_SPECIFIC;
                        else instructions = 'Focus on the semantic meaning and structure of the content.';

                        const systemPrompt: Message = {
                            role: 'system',
                            content: `${CORE_INSTRUCTIONS} ${instructions} ${RESPONSE_FORMAT} ${STRICT_RULES}`
                        };
                        const userPrompt: Message = {
                            role: 'user',
                            content: `[FILE: ${fileId}]\n${meta.content}`
                        };
                        const rawSummary = await this.llm.call(
                            [systemPrompt, userPrompt],
                            `indexing:${fileId}`,
                            signal,
                            undefined,
                            indexerFlow
                        );
                        const summary = typeof rawSummary === 'object' && rawSummary !== null ? rawSummary : {};
                        semanticIndex[fileId] = { ...summary, hash: meta.hash };
                    }
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