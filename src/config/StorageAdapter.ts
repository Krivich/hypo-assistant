// src/config/StorageAdapter.ts

import type { PatchGroup, Sources, StoredPatch } from '../types';

const CONFIG_KEY = 'hypoAssistantConfig';
const ORIGINALS_KEY = 'hypoAssistantOriginals';
const SEMANTIC_INDEX_KEY = 'hypoAssistantSemanticIndex';
const PATCH_GROUPS_KEY = 'hypoAssistantPatchGroups'; // ← новый ключ
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

    getPatchGroups(): PatchGroup[] {
        const raw = localStorage.getItem(PATCH_GROUPS_KEY);
        return raw ? JSON.parse(raw) : [];
    }

    savePatchGroups(groups: PatchGroup[]): void {
        localStorage.setItem(PATCH_GROUPS_KEY, JSON.stringify(groups));
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
}