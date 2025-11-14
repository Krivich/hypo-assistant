// ТЕЗИС: Этот класс объединяет две связанные обязанности: детекция переполнения контекста и выполнение адаптивного чанкинга.
// ТЕЗИС: Чанкер работает итеративно: при переполнении уменьшает размер чанка и повторяет попытку, не создавая рекурсивных чанкеров.
import type { Message } from '../types';
import type { LLMClient } from './LLMClient';
import { AdaptiveProgressObserver } from '../utils/AdaptiveProgressObserver.js';
import {AppConfig} from "../config/AppConfig";

export class ChunkedLlmSupport {
    // === Детектирует переполнение в любом формате ===
    static isContextOverflowError(error: unknown): { maxTokens: number; usedTokens: number } | null {
        let message = '';
        if (typeof error === 'object' && error !== null) {
            if ('error' in error && typeof (error as any).error === 'object') {
                message = (error as any).error.message || '';
            } else if (error instanceof Error) {
                message = error.message;
            }
        } else if (typeof error === 'string') {
            message = error;
        }
        // === Кейс A: HTTP 400 (OpenRouter-style) ===
        const max400 = message.match(/maximum context length is (\d+) tokens/i);
        const req400 = message.match(/requested about (\d+) tokens/i);
        if (max400 && req400) {
            return {
                maxTokens: parseInt(max400[1]),
                usedTokens: parseInt(req400[1])
            };
        }
        // === Кейс B: Chutes — "The input (X tokens) ... model's context length (Y tokens)" ===
        const input200 = message.match(/The input \((\d+) tokens\)/);
        const max200 = message.match(/model's context length \((\d+) tokens\)/);
        if (input200 && max200) {
            return {
                usedTokens: parseInt(input200[1]),
                maxTokens: parseInt(max200[1])
            };
        }
        // === Кейс C: Chutes — "Requested token count exceeds... total of X tokens: A from input..." ===
        const max300 = message.match(/maximum context length of (\d+) tokens/i);
        const input300 = message.match(/(\d+) tokens from the input messages/);
        if (max300 && input300) {
            return {
                maxTokens: parseInt(max300[1]),
                usedTokens: parseInt(input300[1])
            };
        }
        return null;
    }

    static async handleChunkedInference(
        originalSystemPrompt: string,
        originalUserPrompt: string,
        maxTokens: number,
        usedTokens: number,
        context: string,
        llmClient: LLMClient,
        config: AppConfig,
        progress?: AdaptiveProgressObserver,
        signal?: AbortSignal
    ): Promise<unknown> {
        const inputLength = new Blob([JSON.stringify([
            { role: 'system', content: originalSystemPrompt },
            { role: 'user', content: originalUserPrompt }
        ])]).size;
        const charsPerToken = inputLength / usedTokens;
        const safetyMargin = 0.85;
        const maxCompletionTokens = 2048;
        const maxPromptTokens = Math.floor(maxTokens * safetyMargin - maxCompletionTokens);
        const minChunkChars = 500;
        const overlapRatio = 0.1;

        const estimatedOverheadSize = new Blob([JSON.stringify([
            { role: 'system', content: this.buildChunkedSystemPrompt(originalSystemPrompt, null, 1) },
            { role: 'user', content: '[CHUNK 1]\n' }
        ])]).size;
        const estimatedOverheadTokens = Math.ceil(estimatedOverheadSize / charsPerToken);
        const estimatedAvailableTokens = maxPromptTokens - estimatedOverheadTokens;
        const estimatedChunkChars = Math.max(minChunkChars, Math.floor(estimatedAvailableTokens * charsPerToken));
        const estimatedTotalChunks = Math.ceil(originalUserPrompt.length / estimatedChunkChars);

        // === Определяем базовый префикс для статуса ===
        const baseAction = context.split(':')[0]; // например, "indexing" или "relevance"

        // Первое обновление: начало обработки
        let chunkFlow = progress?.startFlow({
            steps: estimatedTotalChunks + 1,
            stepTimeMs: config.get(60000, 'llm.timeouts.generationMs')
        });

        let remainingText = originalUserPrompt;
        const intermediateResults: string[] = [];
        let chunkIndex = 1;
        const maxAttemptsPerChunk = 6;

        while (remainingText.length > 0) {
            // === ТЕЗИС: Вычисляем параметры чанка ОДИН РАЗ, чтобы избежать сброса размера между попытками ===
            const systemPromptBase = this.buildChunkedSystemPrompt(
                originalSystemPrompt,
                intermediateResults.length > 0 ? intermediateResults : null,
                chunkIndex
            );
            const userPromptTemplate = `[CHUNK ${chunkIndex}]\n`;
            const overheadSize = new Blob([JSON.stringify([
                { role: 'system', content: systemPromptBase },
                { role: 'user', content: userPromptTemplate }
            ])]).size;
            const overheadTokens = Math.ceil(overheadSize / charsPerToken);

            if (overheadTokens >= maxPromptTokens) {
                throw new Error(`Prompt overhead (${overheadTokens}) exceeds limit (${maxPromptTokens}) — cannot fit any content.`);
            }

            const availableTokens = maxPromptTokens - overheadTokens;
            const availableChars = Math.floor(availableTokens * charsPerToken);
            let chunkSize = Math.max(minChunkChars, availableChars);
            let attempts = 0;

            while (attempts < maxAttemptsPerChunk) {
                const actualChunk = remainingText.substring(0, chunkSize);
                const fullUserPrompt = `[CHUNK ${chunkIndex}]\n${actualChunk}`;
                const messages: Message[] = [
                    { role: 'system', content: systemPromptBase },
                    { role: 'user', content: fullUserPrompt }
                ];

                const contextWithEstimate = `${context}:chunk:${chunkIndex}of~${estimatedTotalChunks}`;
                try {
                    chunkFlow?.startStep(`Chunk ${chunkIndex} of ~${estimatedTotalChunks}`);

                    const result = await llmClient.call(
                        messages,
                        contextWithEstimate,
                        signal,
                        (err) => ChunkedLlmSupport.isContextOverflowError(err) !== null,
                        chunkFlow
                    );

                    intermediateResults.push(typeof result === 'string' ? result : JSON.stringify(result));
                    const overlapChars = Math.floor(chunkSize * overlapRatio);
                    remainingText = remainingText.substring(chunkSize - overlapChars);
                    chunkIndex++;

                    break;
                } catch (err) {
                    const overflow = ChunkedLlmSupport.isContextOverflowError(err);
                    if (overflow && attempts < maxAttemptsPerChunk - 1) {
                        chunkSize = Math.max(minChunkChars, Math.floor(chunkSize * 0.7));
                        attempts++;
                        continue;
                    } else {
                        throw err;
                    }
                }
            }
        }

        // Финальная агрегация
        chunkFlow?.startStep("Final aggregation...");

        const finalSystemPrompt = this.buildFinalSystemPrompt(originalSystemPrompt, intermediateResults);
        const finalMessages: Message[] = [
            { role: 'system', content: finalSystemPrompt },
            { role: 'user', content: '[BEGIN AGGREGATED RESULTS]' }
        ];

        return await llmClient.call(
            finalMessages,
            `${context}:final_aggregation`,
            signal,
            undefined,
            chunkFlow
        );
    }
    // === Запуск чанкинга ===

    // === Вспомогательные методы (БЕЗ ИЗМЕНЕНИЙ) ===
    private static buildChunkedSystemPrompt(
        originalSystemPrompt: string,
        previousResults: string[] | null,
        currentChunkIndex: number
    ): string {
        const originalMarked = `=== BEGIN ORIGINAL SYSTEM PROMPT ===
${originalSystemPrompt}
=== END OF ORIGINAL SYSTEM PROMPT ===
`;
        const prevSection = previousResults
            ? `Context from previous chunks (DO NOT repeat this information):
${previousResults.map((res, idx) => `[RESULT FROM CHUNK ${idx + 1}]
${res}`).join('\n')}`
            : 'No previous chunks.';
        return `${originalMarked}=== CHUNKED INFERENCE MODE ===
You are processing chunk ${currentChunkIndex} of a large user input (total number unknown) that was split due to context length limits.
- You DO NOT have access to the full input — only the current chunk.
- The FINAL output must satisfy the original system prompt exactly as specified above.
- ${prevSection}
- Generate ONLY an incremental, structured analysis of the CURRENT chunk.
- DO NOT generate the final answer.
- Keep output concise and machine-readable.
- Your output will be concatenated with others and passed to a final aggregation step.
- The final step will NOT have access to the original input — ONLY to the concatenated outputs of all chunks.
- Therefore, your output MUST be SELF-CONTAINED.
Return ONLY your analysis. No explanations.
=== END CHUNKED MODE ===`;
    }

    private static buildFinalSystemPrompt(
        originalSystemPrompt: string,
        intermediateResults: string[]
    ): string {
        const originalMarked = `=== BEGIN ORIGINAL SYSTEM PROMPT ===
${originalSystemPrompt}
=== END OF ORIGINAL SYSTEM PROMPT ===
`;
        const resultsText = intermediateResults
            .map((res, idx) => `[RESULT FROM CHUNK ${idx + 1}]
${res}`)
            .join('\n');
        return `${originalMarked}=== FINAL AGGREGATION PHASE ===
You are now fulfilling the original user request as defined in the system prompt above.
You have been provided with a structured summary that aggregates analyses from all chunks of the original input.
- You DO NOT have access to the original input — ONLY the aggregated summary below.
- You MUST produce the FINAL output in the EXACT FORMAT and STYLE specified in the original system prompt.
- Synthesize the summary into a single, coherent response.
- If critical information is missing, state so explicitly — DO NOT hallucinate.
Aggregated analysis from all chunks:
${resultsText}
Now generate your final output.
=== END AGGREGATION ===`;
    }
}