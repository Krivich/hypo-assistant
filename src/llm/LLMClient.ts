// ТЕЗИС: LLM-клиент обрабатывает и 400-ые ошибки, и 200-ые с JSON-ошибкой.
// ТЕЗИС: При ошибке переполнения контекста на верхнем уровне — автоматически запускается чанкинг.
// ТЕЗИС: Если передан isNonRetryableError и он возвращает true — ошибка пробрасывается без retry.
import type { Message } from '../types';
import { AppConfig } from '../config/AppConfig';
import { StorageAdapter } from '../config/StorageAdapter';
import { ChunkedLlmSupport } from './ChunkedLlmSupport';
import { AdaptiveProgressObserver } from '../utils/AdaptiveProgressObserver.js';

export class LLMClient {
    constructor(private config: AppConfig, private storage: StorageAdapter) {}

    private logAndReportTokens(
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
        messages: Message[],
        rawContent: string,
        model: string,
        provider: string,
        context: string
    ): void {
        const { prompt_tokens, completion_tokens } = usage;
        const allStats = this.storage.getLLMUsage();
        const modelKey = `${provider}::${model}`;
        const now = new Date();
        const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        if (!allStats[modelKey]) {
            allStats[modelKey] = { daily: {}, total: { prompt: 0, completion: 0, requests: 0 } };
        }
        if (!allStats[modelKey].daily[dayKey]) {
            allStats[modelKey].daily[dayKey] = { prompt: 0, completion: 0, requests: 0 };
        }
        const d = allStats[modelKey].daily[dayKey];
        d.prompt += prompt_tokens;
        d.completion += completion_tokens;
        d.requests += 1;
        const t = allStats[modelKey].total;
        t.prompt += prompt_tokens;
        t.completion += completion_tokens;
        t.requests += 1;
        this.storage.saveLLMUsage(allStats);
        console.groupCollapsed(
            `[LLM Usage] ${context} → ${modelKey}: ${prompt_tokens}↑ + ${completion_tokens}↓ = ${usage.total_tokens} tokens`
        );
        console.log('➡️ Request:', messages);
        console.log('⬅️ Response:', rawContent);
        console.groupEnd();
    }

    async call(
        messages: Message[],
        context: string,
        signal?: AbortSignal,
        isNonRetryableError?: (error: unknown) => boolean,
        progress?: AdaptiveProgressObserver
    ): Promise<unknown> {

        const apiEndpoint = this.config.get<string>('https://openrouter.ai/api/v1/chat/completions', 'llm.apiEndpoint');
        const apiKey = this.config.get('', 'llm.apiKey');
        const model = this.config.get('tngtech/deepseek-r1t2-chimera:free', 'llm.model');
        const timeoutMs = this.config.get(60000, 'llm.timeouts.generationMs');
        const maxRetries = this.config.get(20, 'llm.maxRetries');
        const retryDelayBaseMs = this.config.get(1000, 'llm.retryDelayBaseMs');

        let urlToUse = apiEndpoint;
        try {
            const urlObj = new URL(apiEndpoint);
            urlObj.searchParams.set('_context', context);
            urlToUse = urlObj.toString();
        } catch (e) {}

        let lastError: Error | null = null;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                progress?.updateEstimate(timeoutMs);
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            const combinedSignal = signal
                ? AbortSignal.any([signal, controller.signal])
                : controller.signal;

            try {
                const headers: Record<string, string> = {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                };
                if (urlToUse.includes('openrouter.ai')) {
                    headers['HTTP-Referer'] = 'https://your-domain.com';
                    headers['X-Title'] = 'HypoAssistant';
                }

                // === ТЕЗИС: Ограничиваем длину ответа, чтобы избежать переполнения из-за completion tokens ===
                const maxTokensResponse = 2048;
                const response = await fetch(urlToUse, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        model,
                        messages,
                        temperature: 0.1,
                        max_tokens: maxTokensResponse,
                        response_format: { type: 'json_object' }
                    }),
                    signal: combinedSignal
                });

                clearTimeout(timeoutId);
                const data = await response.json();
                if (data.error) {
                    if (isNonRetryableError?.(data)) {
                        throw data;
                    }

                    // === ТЕЗИС: Проверяем переполнение контекста на верхнем уровне ===
                    const overflow = ChunkedLlmSupport.isContextOverflowError(data);
                    if (overflow) {
                        const systemMsg = messages.find(m => m.role === 'system');
                        const userMsg = messages.find(m => m.role === 'user');
                        if (systemMsg && userMsg) {
                            return await ChunkedLlmSupport.handleChunkedInference(
                                systemMsg.content,
                                userMsg.content,
                                overflow.maxTokens,
                                overflow.usedTokens,
                                context,
                                this,
                                this.config,
                                progress,
                                signal
                            );
                        }
                    }
                    throw new Error(`LLM Error: ${data.error.message}`);
                }

                progress?.updateEstimate(0);
                if (data.usage) {
                    this.logAndReportTokens(
                        data.usage,
                        messages,
                        data.choices?.[0]?.message?.content || '',
                        model,
                        'openrouter',
                        context
                    );
                }
                const content = data.choices?.[0]?.message?.content;
                if (!content) throw new Error('Empty LLM response');
                const clean = content.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
                return JSON.parse(clean);
            } catch (err) {
                clearTimeout(timeoutId);

                if (isNonRetryableError?.(err)) {
                    throw err;
                }

                // === ТЕЗИС: Аналогично — проверяем переполнение в исключениях ===
                const overflow = ChunkedLlmSupport.isContextOverflowError(err);
                if (overflow) {
                    const systemMsg = messages.find(m => m.role === 'system');
                    const userMsg = messages.find(m => m.role === 'user');
                    if (systemMsg && userMsg) {
                        return await ChunkedLlmSupport.handleChunkedInference(
                            systemMsg.content,
                            userMsg.content,
                            overflow.maxTokens,
                            overflow.usedTokens,
                            context,
                            this,
                            this.config,
                            progress,
                            signal
                        );
                    }
                }
                lastError = err as Error;
                if (attempt < maxRetries && !signal?.aborted) {
                    await new Promise(r => setTimeout(r, retryDelayBaseMs * Math.pow(2, attempt)));
                    continue;
                }
                break;
            }
        }
        throw lastError!;
    }
}