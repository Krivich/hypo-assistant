// ТЕЗИС: Хранилище — это адаптер, а не глобальное состояние. Оно не знает логики, только ключи и структуру.
// ТЕЗИС: Все операции с localStorage изолированы в одном месте — это упрощает миграцию на IndexedDB.

import type {PatchGroup, Sources, StoredPatch} from '../types';

const CONFIG_KEY = 'hypoAssistantConfig';
const ORIGINALS_KEY = 'hypoAssistantOriginals';
const SEMANTIC_INDEX_KEY = 'hypoAssistantSemanticIndex';
const PATCHES_KEY = 'hypoAssistantPatches';
const DIAGNOSTICS_KEY = 'hypoAssistantDiagnostics';
const LLM_USAGE_KEY = 'hypoAssistantLLMUsage';

export interface Diagnostics {
    runs: Array<{ timestamp: string; phase: string; data: unknown }>;
}

export interface LLMUsageStats {
    [modelKey: string]: {
        daily: Record<string, { prompt: number; completion: number; requests: number }>;
        total: { prompt: number; completion: number; requests: number };
    };
}

export class StorageAdapter {
    getOriginals(): Sources | null {
        const raw = localStorage.getItem(ORIGINALS_KEY);
        return raw ? JSON.parse(raw) : null;
    }

    saveOriginals(sources: Sources): void {
        localStorage.setItem(ORIGINALS_KEY, JSON.stringify(sources));
    }

    getSemanticIndex(): Record<string, unknown> | null {
        const raw = localStorage.getItem(SEMANTIC_INDEX_KEY);
        return raw ? JSON.parse(raw) : null;
    }

    saveSemanticIndex(index: Record<string, unknown>): void {
        localStorage.setItem(SEMANTIC_INDEX_KEY, JSON.stringify(index));
    }

    // Возвращаем StoredPatch[], а не старый Patch[]
    getPatches(): StoredPatch[] {
        const raw = localStorage.getItem(PATCHES_KEY);
        return raw ? JSON.parse(raw) : [];
    }

    savePatches(patches: StoredPatch[]): void {
        localStorage.setItem(PATCHES_KEY, JSON.stringify(patches));
    }

    getDiagnostics(): Diagnostics {
        const raw = localStorage.getItem(DIAGNOSTICS_KEY);
        return raw ? JSON.parse(raw) : { runs: [] };
    }

    saveDiagnostics(diagnostics: Diagnostics): void {
        localStorage.setItem(DIAGNOSTICS_KEY, JSON.stringify(diagnostics, null, 2));
    }

    getLLMUsage(): LLMUsageStats {
        const raw = localStorage.getItem(LLM_USAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    }

    saveLLMUsage(stats: LLMUsageStats): void {
        localStorage.setItem(LLM_USAGE_KEY, JSON.stringify(stats, null, 2));
    }

    // Возвращает группированные сессии (для UI)
    getPatchSessions(): PatchGroup[] {
        const patches = this.getPatches();
        const groups = new Map<string, PatchGroup>();

        // Группируем по requestId
        for (const patch of patches) {
            if (!groups.has(patch.requestId)) {
                groups.set(patch.requestId, {
                    requestId: patch.requestId,
                    userQuery: patch.title, // fallback если нет отдельного запроса
                    groupTitle: patch.title, // временное значение — будет перезаписано
                    patches: []
                });
            }
            groups.get(patch.requestId)!.patches.push(patch);
        }

        // Преобразуем в массив и улучшаем заголовки
        return Array.from(groups.values()).map(group => {
            // Лучший групповой заголовок — берём из любого патча (они одинаковые)
            const title = group.patches[0]?.title.split(' → ')[0] || group.groupTitle;
            return {
                ...group,
                groupTitle: title.length > 80 ? title.substring(0, 77) + '...' : title
            };
        });
    }
}