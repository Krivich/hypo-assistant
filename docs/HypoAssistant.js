"use strict";
var HypoAssistant = (() => {
  // src/config/AppConfig.ts
  var AppConfig = class {
    externalConfig = null;
    localStorageKey = "hypoAssistantConfig";
    async init() {
      try {
        const resp = await fetch("/app-config.json");
        if (resp.ok) {
          this.externalConfig = await resp.json();
        }
      } catch (e) {
      }
    }
    get(defaultValue, path) {
      const localStorageRaw = localStorage.getItem(this.localStorageKey);
      const localStorageConfig = localStorageRaw ? JSON.parse(localStorageRaw) : null;
      const getNested = (obj, p) => {
        if (!obj || typeof obj !== "object") return void 0;
        const keys = p.split(".");
        let current = obj;
        for (const key of keys) {
          if (current == null || typeof current !== "object") return void 0;
          current = current[key];
        }
        return current;
      };
      const fromLocalStorage = localStorageConfig ? getNested(localStorageConfig, path) : void 0;
      if (fromLocalStorage !== void 0) return fromLocalStorage;
      const fromExternal = this.externalConfig ? getNested(this.externalConfig, path) : void 0;
      if (fromExternal !== void 0) return fromExternal;
      return defaultValue;
    }
    set(path, value) {
      const raw = localStorage.getItem(this.localStorageKey);
      const config = raw ? JSON.parse(raw) : {};
      const keys = path.split(".");
      let current = config;
      for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (!(key in current) || typeof current[key] !== "object" || current[key] === null) {
          current[key] = {};
        }
        current = current[key];
      }
      current[keys[keys.length - 1]] = value;
      localStorage.setItem(this.localStorageKey, JSON.stringify(config));
    }
  };

  // src/config/StorageAdapter.ts
  var ORIGINALS_KEY = "hypoAssistantOriginals";
  var SEMANTIC_INDEX_KEY = "hypoAssistantSemanticIndex";
  var PATCHES_KEY = "hypoAssistantPatches";
  var DIAGNOSTICS_KEY = "hypoAssistantDiagnostics";
  var LLM_USAGE_KEY = "hypoAssistantLLMUsage";
  var StorageAdapter = class {
    getOriginals() {
      const raw = localStorage.getItem(ORIGINALS_KEY);
      return raw ? JSON.parse(raw) : null;
    }
    saveOriginals(sources) {
      localStorage.setItem(ORIGINALS_KEY, JSON.stringify(sources));
    }
    getSemanticIndex() {
      const raw = localStorage.getItem(SEMANTIC_INDEX_KEY);
      return raw ? JSON.parse(raw) : null;
    }
    saveSemanticIndex(index) {
      localStorage.setItem(SEMANTIC_INDEX_KEY, JSON.stringify(index));
    }
    // Возвращаем StoredPatch[], а не старый Patch[]
    getPatches() {
      const raw = localStorage.getItem(PATCHES_KEY);
      return raw ? JSON.parse(raw) : [];
    }
    savePatches(patches) {
      localStorage.setItem(PATCHES_KEY, JSON.stringify(patches));
    }
    getDiagnostics() {
      const raw = localStorage.getItem(DIAGNOSTICS_KEY);
      return raw ? JSON.parse(raw) : { runs: [] };
    }
    saveDiagnostics(diagnostics) {
      localStorage.setItem(DIAGNOSTICS_KEY, JSON.stringify(diagnostics, null, 2));
    }
    getLLMUsage() {
      const raw = localStorage.getItem(LLM_USAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    }
    saveLLMUsage(stats) {
      localStorage.setItem(LLM_USAGE_KEY, JSON.stringify(stats, null, 2));
    }
  };

  // src/llm/ChunkedLlmSupport.ts
  var ChunkedLlmSupport = class _ChunkedLlmSupport {
    // === Детектирует переполнение в любом формате ===
    static isContextOverflowError(error) {
      let message = "";
      if (typeof error === "object" && error !== null) {
        if ("error" in error && typeof error.error === "object") {
          message = error.error.message || "";
        } else if (error instanceof Error) {
          message = error.message;
        }
      } else if (typeof error === "string") {
        message = error;
      }
      const max400 = message.match(/maximum context length is (\d+) tokens/i);
      const req400 = message.match(/requested about (\d+) tokens/i);
      if (max400 && req400) {
        return {
          maxTokens: parseInt(max400[1]),
          usedTokens: parseInt(req400[1])
        };
      }
      const input200 = message.match(/The input \((\d+) tokens\)/);
      const max200 = message.match(/model's context length \((\d+) tokens\)/);
      if (input200 && max200) {
        return {
          usedTokens: parseInt(input200[1]),
          maxTokens: parseInt(max200[1])
        };
      }
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
    static async handleChunkedInference(originalSystemPrompt, originalUserPrompt, maxTokens, usedTokens, context, llmClient, config, progress, signal) {
      const inputLength = new Blob([JSON.stringify([
        { role: "system", content: originalSystemPrompt },
        { role: "user", content: originalUserPrompt }
      ])]).size;
      const charsPerToken = inputLength / usedTokens;
      const safetyMargin = 0.85;
      const maxCompletionTokens = 2048;
      const maxPromptTokens = Math.floor(maxTokens * safetyMargin - maxCompletionTokens);
      const minChunkChars = 500;
      const overlapRatio = 0.1;
      const estimatedOverheadSize = new Blob([JSON.stringify([
        { role: "system", content: this.buildChunkedSystemPrompt(originalSystemPrompt, null, 1) },
        { role: "user", content: "[CHUNK 1]\n" }
      ])]).size;
      const estimatedOverheadTokens = Math.ceil(estimatedOverheadSize / charsPerToken);
      const estimatedAvailableTokens = maxPromptTokens - estimatedOverheadTokens;
      const estimatedChunkChars = Math.max(minChunkChars, Math.floor(estimatedAvailableTokens * charsPerToken));
      const estimatedTotalChunks = Math.ceil(originalUserPrompt.length / estimatedChunkChars);
      const baseAction = context.split(":")[0];
      let chunkFlow = progress?.startFlow({
        steps: estimatedTotalChunks + 1,
        stepTimeMs: config.get(6e4, "llm.timeouts.generationMs")
      });
      let remainingText = originalUserPrompt;
      const intermediateResults = [];
      let chunkIndex = 1;
      const maxAttemptsPerChunk = 6;
      while (remainingText.length > 0) {
        const systemPromptBase = this.buildChunkedSystemPrompt(
          originalSystemPrompt,
          intermediateResults.length > 0 ? intermediateResults : null,
          chunkIndex
        );
        const userPromptTemplate = `[CHUNK ${chunkIndex}]
`;
        const overheadSize = new Blob([JSON.stringify([
          { role: "system", content: systemPromptBase },
          { role: "user", content: userPromptTemplate }
        ])]).size;
        const overheadTokens = Math.ceil(overheadSize / charsPerToken);
        if (overheadTokens >= maxPromptTokens) {
          throw new Error(`Prompt overhead (${overheadTokens}) exceeds limit (${maxPromptTokens}) \u2014 cannot fit any content.`);
        }
        const availableTokens = maxPromptTokens - overheadTokens;
        const availableChars = Math.floor(availableTokens * charsPerToken);
        let chunkSize = Math.max(minChunkChars, availableChars);
        let attempts = 0;
        while (attempts < maxAttemptsPerChunk) {
          const actualChunk = remainingText.substring(0, chunkSize);
          const fullUserPrompt = `[CHUNK ${chunkIndex}]
${actualChunk}`;
          const messages = [
            { role: "system", content: systemPromptBase },
            { role: "user", content: fullUserPrompt }
          ];
          const contextWithEstimate = `${context}:chunk:${chunkIndex}of~${estimatedTotalChunks}`;
          try {
            chunkFlow?.startStep(`Chunk ${chunkIndex} of ~${estimatedTotalChunks}`);
            const result = await llmClient.call(
              messages,
              contextWithEstimate,
              signal,
              (err) => _ChunkedLlmSupport.isContextOverflowError(err) !== null,
              chunkFlow
            );
            intermediateResults.push(typeof result === "string" ? result : JSON.stringify(result));
            const overlapChars = Math.floor(chunkSize * overlapRatio);
            remainingText = remainingText.substring(chunkSize - overlapChars);
            chunkIndex++;
            break;
          } catch (err) {
            const overflow = _ChunkedLlmSupport.isContextOverflowError(err);
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
      chunkFlow?.startStep("Final aggregation...");
      const finalSystemPrompt = this.buildFinalSystemPrompt(originalSystemPrompt, intermediateResults);
      const finalMessages = [
        { role: "system", content: finalSystemPrompt },
        { role: "user", content: "[BEGIN AGGREGATED RESULTS]" }
      ];
      return await llmClient.call(
        finalMessages,
        `${context}:final_aggregation`,
        signal,
        void 0,
        chunkFlow
      );
    }
    // === Запуск чанкинга ===
    // === Вспомогательные методы (БЕЗ ИЗМЕНЕНИЙ) ===
    static buildChunkedSystemPrompt(originalSystemPrompt, previousResults, currentChunkIndex) {
      const originalMarked = `=== BEGIN ORIGINAL SYSTEM PROMPT ===
${originalSystemPrompt}
=== END OF ORIGINAL SYSTEM PROMPT ===
`;
      const prevSection = previousResults ? `Context from previous chunks (DO NOT repeat this information):
${previousResults.map((res, idx) => `[RESULT FROM CHUNK ${idx + 1}]
${res}`).join("\n")}` : "No previous chunks.";
      return `${originalMarked}=== CHUNKED INFERENCE MODE ===
You are processing chunk ${currentChunkIndex} of a large user input (total number unknown) that was split due to context length limits.
- You DO NOT have access to the full input \u2014 only the current chunk.
- The FINAL output must satisfy the original system prompt exactly as specified above.
- ${prevSection}
- Generate ONLY an incremental, structured analysis of the CURRENT chunk.
- DO NOT generate the final answer.
- Keep output concise and machine-readable.
- Your output will be concatenated with others and passed to a final aggregation step.
- The final step will NOT have access to the original input \u2014 ONLY to the concatenated outputs of all chunks.
- Therefore, your output MUST be SELF-CONTAINED.
Return ONLY your analysis. No explanations.
=== END CHUNKED MODE ===`;
    }
    static buildFinalSystemPrompt(originalSystemPrompt, intermediateResults) {
      const originalMarked = `=== BEGIN ORIGINAL SYSTEM PROMPT ===
${originalSystemPrompt}
=== END OF ORIGINAL SYSTEM PROMPT ===
`;
      const resultsText = intermediateResults.map((res, idx) => `[RESULT FROM CHUNK ${idx + 1}]
${res}`).join("\n");
      return `${originalMarked}=== FINAL AGGREGATION PHASE ===
You are now fulfilling the original user request as defined in the system prompt above.
You have been provided with a structured summary that aggregates analyses from all chunks of the original input.
- You DO NOT have access to the original input \u2014 ONLY the aggregated summary below.
- You MUST produce the FINAL output in the EXACT FORMAT and STYLE specified in the original system prompt.
- Synthesize the summary into a single, coherent response.
- If critical information is missing, state so explicitly \u2014 DO NOT hallucinate.
Aggregated analysis from all chunks:
${resultsText}
Now generate your final output.
=== END AGGREGATION ===`;
    }
  };

  // src/llm/LLMClient.ts
  var LLMClient = class {
    constructor(config, storage) {
      this.config = config;
      this.storage = storage;
    }
    logAndReportTokens(usage, messages, rawContent, model, provider, context) {
      const { prompt_tokens, completion_tokens } = usage;
      const allStats = this.storage.getLLMUsage();
      const modelKey = `${provider}::${model}`;
      const now = /* @__PURE__ */ new Date();
      const dayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
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
        `[LLM Usage] ${context} \u2192 ${modelKey}: ${prompt_tokens}\u2191 + ${completion_tokens}\u2193 = ${usage.total_tokens} tokens`
      );
      console.log("\u27A1\uFE0F Request:", messages);
      console.log("\u2B05\uFE0F Response:", rawContent);
      console.groupEnd();
    }
    async call(messages, context, signal, isNonRetryableError, progress) {
      const apiEndpoint = this.config.get("https://openrouter.ai/api/v1/chat/completions", "llm.apiEndpoint");
      const apiKey = this.config.get("", "llm.apiKey");
      const model = this.config.get("tngtech/deepseek-r1t2-chimera:free", "llm.model");
      const timeoutMs = this.config.get(6e4, "llm.timeouts.generationMs");
      const maxRetries = this.config.get(20, "llm.maxRetries");
      const retryDelayBaseMs = this.config.get(1e3, "llm.retryDelayBaseMs");
      let urlToUse = apiEndpoint;
      try {
        const urlObj = new URL(apiEndpoint);
        urlObj.searchParams.set("_context", context);
        urlToUse = urlObj.toString();
      } catch (e) {
      }
      let lastError = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          progress?.updateEstimate(timeoutMs);
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        try {
          const headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
          };
          if (urlToUse.includes("openrouter.ai")) {
            headers["HTTP-Referer"] = "https://your-domain.com";
            headers["X-Title"] = "HypoAssistant";
          }
          const maxTokensResponse = 2048;
          const response = await fetch(urlToUse, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model,
              messages,
              temperature: 0.1,
              max_tokens: maxTokensResponse,
              response_format: { type: "json_object" }
            }),
            signal: combinedSignal
          });
          clearTimeout(timeoutId);
          const data = await response.json();
          if (data.error) {
            if (isNonRetryableError?.(data)) {
              throw data;
            }
            const overflow = ChunkedLlmSupport.isContextOverflowError(data);
            if (overflow) {
              const systemMsg = messages.find((m) => m.role === "system");
              const userMsg = messages.find((m) => m.role === "user");
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
              data.choices?.[0]?.message?.content || "",
              model,
              "openrouter",
              context
            );
          }
          const content = data.choices?.[0]?.message?.content;
          if (!content) throw new Error("Empty LLM response");
          const clean = content.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
          return JSON.parse(clean);
        } catch (err) {
          clearTimeout(timeoutId);
          if (isNonRetryableError?.(err)) {
            throw err;
          }
          const overflow = ChunkedLlmSupport.isContextOverflowError(err);
          if (overflow) {
            const systemMsg = messages.find((m) => m.role === "system");
            const userMsg = messages.find((m) => m.role === "user");
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
          lastError = err;
          if (attempt < maxRetries && !signal?.aborted) {
            await new Promise((r) => setTimeout(r, retryDelayBaseMs * Math.pow(2, attempt)));
            continue;
          }
          break;
        }
      }
      throw lastError;
    }
  };

  // src/core/SourceCollector.ts
  async function sha256(str) {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function collectOriginalSources() {
    const sources = {};
    const htmlContent = document.documentElement.outerHTML;
    const htmlHash = await sha256(htmlContent);
    sources["HTML_DOC"] = {
      type: "html",
      content: htmlContent,
      hash: htmlHash,
      signatureStart: "<!--==HTML_DOC==-->",
      signatureEnd: "<!--==/HTML_DOC==-->"
    };
    document.querySelectorAll('script:not([src]):not([id="hypo-assistant-core"])').forEach((el, i) => {
      const content = el.textContent || "";
      sha256(content).then((hash) => {
        const id = `inline-script-${i}`;
        sources[id] = {
          type: "js",
          content,
          hash,
          signatureStart: `/*==${id}==*/`,
          signatureEnd: `/*==/${id}==*/`
        };
      });
    });
    const scriptLinks = Array.from(document.querySelectorAll("script[src]"));
    for (let i = 0; i < scriptLinks.length; i++) {
      const script = scriptLinks[i];
      try {
        const resp = await fetch(script.src);
        const content = await resp.text();
        const hash = await sha256(content);
        const id = `external-script-${i}`;
        sources[id] = {
          type: "js",
          content,
          hash,
          signatureStart: `/*==${id}==*/`,
          signatureEnd: `/*==/${id}==*/`
        };
      } catch (e) {
        console.warn("Failed to fetch JS:", script.src);
      }
    }
    document.querySelectorAll("style").forEach((el, i) => {
      const content = el.textContent || "";
      sha256(content).then((hash) => {
        const id = `inline-style-${i}`;
        sources[id] = {
          type: "css",
          content,
          hash,
          signatureStart: `/*==${id}==*/`,
          signatureEnd: `/*==/${id}==*/`
        };
      });
    });
    document.querySelectorAll("template").forEach((el, i) => {
      const content = el.innerHTML;
      sha256(content).then((hash) => {
        const id = `template-${i}`;
        sources[id] = {
          type: "html",
          content,
          hash,
          signatureStart: `<!--==${id}==-->`,
          signatureEnd: `<!--==/${id}==-->`
        };
      });
    });
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'));
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      try {
        const resp = await fetch(link.href);
        const content = await resp.text();
        const hash = await sha256(content);
        const id = `linked-css-${i}`;
        sources[id] = {
          type: "css",
          content,
          hash,
          signatureStart: `/*==${id}==*/`,
          signatureEnd: `/*==/${id}==*/`
        };
      } catch (e) {
        console.warn("Failed to fetch CSS:", link.href);
      }
    }
    const syncSources = {};
    syncSources["HTML_DOC"] = {
      type: "html",
      content: htmlContent,
      hash: htmlHash,
      signatureStart: "<!--==HTML_DOC==-->",
      signatureEnd: "<!--==/HTML_DOC==-->"
    };
    const inlineScripts = document.querySelectorAll('script:not([src]):not([id="hypo-assistant-core"])');
    for (let i = 0; i < inlineScripts.length; i++) {
      const el = inlineScripts[i];
      const content = el.textContent || "";
      const hash = await sha256(content);
      const id = `inline-script-${i}`;
      syncSources[id] = {
        type: "js",
        content,
        hash,
        signatureStart: `/*==${id}==*/`,
        signatureEnd: `/*==/${id}==*/`
      };
    }
    const inlineStyles = document.querySelectorAll("style");
    for (let i = 0; i < inlineStyles.length; i++) {
      const el = inlineStyles[i];
      const content = el.textContent || "";
      const hash = await sha256(content);
      const id = `inline-style-${i}`;
      syncSources[id] = {
        type: "css",
        content,
        hash,
        signatureStart: `/*==${id}==*/`,
        signatureEnd: `/*==/${id}==*/`
      };
    }
    const templates = document.querySelectorAll("template");
    for (let i = 0; i < templates.length; i++) {
      const el = templates[i];
      const content = el.innerHTML;
      const hash = await sha256(content);
      const id = `template-${i}`;
      syncSources[id] = {
        type: "html",
        content,
        hash,
        signatureStart: `<!--==${id}==-->`,
        signatureEnd: `<!--==/${id}==-->`
      };
    }
    return syncSources;
  }

  // src/core/SemanticIndexer.ts
  var CORE_INSTRUCTIONS = `
You are generating a single relevance record for a live code editing system.
This record represents one file as a whole \u2014 do not split it into parts.
The system uses these records to select files that contain elements the user might want to modify, replace, or update via code changes.
Later, if selected, the entire file content will be provided to generate a precise patch.
`;
  var HTML_SPECIFIC = `
Focus on:
- Purpose: one sentence \u2014 what does this page do for the user?
- Structure: key interactive or visual zones (e.g. 'theme switcher', 'floating chat panel').
- Identifiers: CSS classes, IDs, DOM queries, event bindings that can be targeted.
- If the HTML appears to be a skeleton (e.g. contains placeholders, lacks real text), explicitly note: "This is likely a server-rendered skeleton; real content may be hydrated from a data script."
- Mention visible text only if it uniquely identifies a section (e.g. headline phrase, product name).
Avoid generic layout terms like 'container', 'wrapper', or 'div'.
`;
  var JS_SPECIFIC = `
Focus on:
- Purpose: one sentence \u2014 what does this script do?
- If it contains structured data (e.g. app state, UI hydration payload, or a JSON-like object with entities like posts, users, products), describe its semantic content (e.g. "list of blog posts") and note: "This block hydrates UI elements in the HTML document."
- If it contains logic (functions, event listeners, DOM mutations), list: global variables, functions, DOM queries, event bindings.
- Do not assume it is executable logic if it only exports or declares data.
Avoid describing built-in APIs unless they define core behavior.
`;
  var CSS_SPECIFIC = `
Focus on:
- Purpose: one sentence \u2014 what does this stylesheet control?
- Key entities: CSS variables (e.g. '--primary'), critical selectors (e.g. '.hero-title'), media queries, and language-specific rules.
Avoid listing every minor rule; focus on what affects layout, theming, or interactivity.
`;
  var RESPONSE_FORMAT = `
Return ONLY a JSON object with:
{
  "purpose": "Exactly one sentence.",
  "key_entities": ["specific, actionable identifiers..."],
  "dependencies": ["file IDs this file interacts with..."]
}
`;
  var STRICT_RULES = `
Rules:
- Be concise, concrete, and focused on what can be changed or is unique.
- Never summarize or generalize.
- If the file is empty or trivial, set purpose to "Trivial or empty file".
- Return ONLY valid JSON. No markdown, no explanation.
`;
  function isFallbackIndex(entry) {
    return entry?.purpose === "One-sentence role" || entry?.purpose === "Unindexed html file" || !Array.isArray(entry?.key_entities) || Array.isArray(entry?.key_entities) && entry.key_entities.length === 3 && entry.key_entities.every((k) => ["functions", "classes", "CSS classes"].includes(k));
  }
  var SemanticIndexer = class {
    constructor(config, storage, llm) {
      this.config = config;
      this.storage = storage;
      this.llm = llm;
    }
    // ТЕЗИС: Валидация и переиндексация выполняются только для реально изменившихся чанков.
    // ТЕЗИС: Пользовательские патчи сохраняются, если LLM подтверждает их валидность.
    async validateAndReindexChunk(fileId, currentMeta, oldIndexEntry, relevantPatches, progress, signal) {
      let fileSpecificInstructions = "";
      if (currentMeta.type === "html") {
        fileSpecificInstructions = HTML_SPECIFIC;
      } else if (currentMeta.type === "js") {
        fileSpecificInstructions = JS_SPECIFIC;
      } else if (currentMeta.type === "css") {
        fileSpecificInstructions = CSS_SPECIFIC;
      } else {
        fileSpecificInstructions = `
Focus on the semantic meaning and structure of the content.
`;
      }
      const validationPrompt = {
        role: "system",
        content: `${CORE_INSTRUCTIONS} ${fileSpecificInstructions} ${RESPONSE_FORMAT} ${STRICT_RULES} The content of file "${fileId}" has changed.
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
      const userPrompt = {
        role: "user",
        content: `[FILE: ${fileId}]
${currentMeta.content}`
      };
      const response = await this.llm.call(
        [validationPrompt, userPrompt],
        `validate_reindex:${fileId}`,
        signal,
        void 0,
        progress
      );
      return response;
    }
    async ensureIndex(progress, signal) {
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
      for (let idx = 0; idx < fileIds.length; idx++) {
        const fileId = fileIds[idx];
        const meta = originals[fileId];
        const stored = semanticIndex[fileId];
        const storedHash = typeof stored === "object" && stored !== null && "hash" in stored ? stored.hash : void 0;
        indexerFlow.startStep(`File ${fileId}`);
        if (!stored || storedHash !== meta.hash || isFallbackIndex(stored)) {
          try {
            if (stored && storedHash !== meta.hash) {
              const allPatches = this.storage.getPatches();
              const relevantPatches = allPatches.filter((p) => p.dependsOn.includes(fileId));
              const result = await this.validateAndReindexChunk(
                fileId,
                meta,
                stored,
                relevantPatches,
                indexerFlow,
                signal
              );
              semanticIndex[fileId] = { ...result.newIndex, hash: meta.hash };
              if (result.validatedPatches?.length) {
                const patchesMap = new Map(result.validatedPatches.map((v) => [v.id, v.valid]));
                const updatedPatches = allPatches.map(
                  (p) => patchesMap.has(p.id) ? { ...p, enabled: patchesMap.get(p.id) === true && p.enabled } : p
                );
                this.storage.savePatches(updatedPatches);
              }
            } else {
              let systemPromptContent = "";
              if (meta.type === "html") {
                systemPromptContent = CORE_INSTRUCTIONS + HTML_SPECIFIC + RESPONSE_FORMAT + STRICT_RULES;
              } else if (meta.type === "js") {
                systemPromptContent = CORE_INSTRUCTIONS + JS_SPECIFIC + RESPONSE_FORMAT + STRICT_RULES;
              } else if (meta.type === "css") {
                systemPromptContent = CORE_INSTRUCTIONS + CSS_SPECIFIC + RESPONSE_FORMAT + STRICT_RULES;
              } else {
                systemPromptContent = CORE_INSTRUCTIONS + `
Focus on the semantic meaning and structure of the content.
` + RESPONSE_FORMAT + STRICT_RULES;
              }
              const systemPrompt = { role: "system", content: systemPromptContent };
              const userPrompt = {
                role: "user",
                content: `[FILE: ${fileId}]
${meta.content}`
              };
              const rawSummary = await this.llm.call(
                [systemPrompt, userPrompt],
                `indexing:${fileId}`,
                signal,
                void 0,
                indexerFlow
              );
              const summary = typeof rawSummary === "object" && rawSummary !== null ? rawSummary : {};
              semanticIndex[fileId] = { ...summary, hash: meta.hash };
            }
            needsSave = true;
          } catch (err) {
            console.warn(`Failed to index ${fileId}:`, err.message);
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
  };

  // src/utils/dedent.ts
  function dedent(strings, ...values) {
    let full = String.raw({ raw: strings }, ...values);
    full = full.replace(/^\n|\n\s*$/g, "");
    const indent = full.match(/^[ \t]*(?=\S)/gm)?.reduce(
      (min, line) => Math.min(min, line.length),
      Infinity
    ) || 0;
    return indent > 0 ? full.replace(new RegExp(`^[ \\t]{${indent}}`, "gm"), "") : full;
  }

  // src/core/Engine.ts
  var HypoAssistantEngine = class {
    constructor(config, storage, llm) {
      this.config = config;
      this.storage = storage;
      this.llm = llm;
    }
    async run(userQuery, progress, signal) {
      const engineFlow = progress.startFlow({ steps: 3, stepTimeMs: 6e4 });
      engineFlow.startStep("Indexing sources");
      const { originals, index: semanticIndex } = await this.indexSources(engineFlow, signal);
      console.group(`[HypoAssistant] \u{1F680} New request: "${userQuery}"`);
      engineFlow.startStep("Finding relevant files");
      const relevantIds = await this.findRelevantFiles(
        userQuery,
        semanticIndex,
        engineFlow,
        signal
      );
      console.log("\u{1F4C1} Relevant files:", relevantIds);
      engineFlow.startStep("Patch generation");
      const { groupTitle, storedPatches } = await this.generatePatches(
        userQuery,
        originals,
        relevantIds,
        engineFlow,
        signal
      );
      if (storedPatches.length === 0) {
        throw new Error("No valid patches generated");
      }
      console.log("\u{1F3C6} Generated group:", { groupTitle, patches: storedPatches });
      const diagnostics = this.storage.getDiagnostics();
      diagnostics.runs.push({
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        phase: "final_tool_call",
        data: { groupTitle, patches: storedPatches }
      });
      this.storage.saveDiagnostics(diagnostics);
      console.groupEnd();
      return {
        message: groupTitle,
        patches: storedPatches,
        groupTitle
      };
    }
    async indexSources(progress, signal) {
      return await new SemanticIndexer(this.config, this.storage, this.llm).ensureIndex(progress, signal);
    }
    async findRelevantFiles(userQuery, semanticIndex, progress, signal) {
      const activePatches = this.storage.getPatches().filter((p) => p.enabled);
      const activePatchesSummary = activePatches.length > 0 ? activePatches.map((p) => `- ${p.title}`).join("\n") : "None";
      const relevancePrompt = {
        role: "system",
        content: dedent`
                Project structure:
                ${JSON.stringify(semanticIndex, null, 2)}
                
                Currently active patches (already applied to the page):
                ${activePatchesSummary}
                
                Note: Applied patches are user-controlled and may be disabled at any time. Do not assume their effects are permanent.
                
                Return {"relevant": ["file_id"]}`
      };
      const userRelevanceMsg = { role: "user", content: userQuery };
      const relevanceRes = await this.llm.call(
        [relevancePrompt, userRelevanceMsg],
        "relevance",
        signal,
        void 0,
        progress
      );
      return relevanceRes.relevant || ["HTML_DOC"];
    }
    async generatePatches(userQuery, originals, relevantIds, progress, signal) {
      const contextBlocks = relevantIds.map((id) => {
        const src = originals[id];
        return src ? `[FILE: ${id}]
${src.content}
[/FILE]` : "";
      }).filter(Boolean).join("\n\n");
      const activePatches = this.storage.getPatches().filter((p) => p.enabled);
      const activePatchesSummary = activePatches.length > 0 ? activePatches.map((p) => `- ${p.title}`).join("\n") : "None";
      const patchPrompt = {
        role: "system",
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
      const userPatchMsg = {
        role: "user",
        content: `Context:
${contextBlocks}

User request: ${userQuery}`
      };
      const patchRes = await this.llm.call(
        [patchPrompt, userPatchMsg],
        "patch",
        signal,
        void 0,
        progress
      );
      let groupTitle = "Untitled change";
      if (typeof patchRes.groupTitle === "string") {
        groupTitle = patchRes.groupTitle.substring(0, 80);
      }
      const rawPatches = Array.isArray(patchRes.patches) ? patchRes.patches : [patchRes];
      const storedPatches = this.createStoredPatches(rawPatches, relevantIds);
      return { groupTitle, storedPatches };
    }
    createStoredPatches(rawPatches, relevantIds) {
      const storedPatches = [];
      for (const p of rawPatches) {
        if (!p.tool || !p.title) continue;
        let toolCall = null;
        let title = p.title.substring(0, 60);
        switch (p.tool) {
          case "setTextContent":
            if (p.selector && p.text !== void 0) {
              toolCall = { tool: "setTextContent", selector: p.selector, text: p.text };
            }
            break;
          case "setAttribute":
            if (p.selector && p.name && p.value !== void 0) {
              toolCall = { tool: "setAttribute", selector: p.selector, name: p.name, value: p.value };
            }
            break;
          case "insertAdjacentHTML":
            if (p.selector && p.position && p.html !== void 0) {
              const pos = p.position;
              if (["beforebegin", "afterbegin", "beforeend", "afterend"].includes(pos)) {
                toolCall = {
                  tool: "insertAdjacentHTML",
                  selector: p.selector,
                  position: pos,
                  html: p.html
                };
              }
            }
            break;
          case "addStyleRule":
            if (p.selector && p.style !== void 0) {
              toolCall = { tool: "addStyleRule", selector: p.selector, style: p.style };
            }
            break;
          case "removeElement":
            if (p.selector) {
              toolCall = { tool: "removeElement", selector: p.selector };
            }
            break;
          case "wrapElement":
            if (p.selector && p.wrapperTag) {
              toolCall = {
                tool: "wrapElement",
                selector: p.selector,
                wrapperTag: p.wrapperTag,
                wrapperClass: p.wrapperClass
              };
            }
            break;
          case "applyTextPatch":
            if (p.file && p.from && p.to) {
              toolCall = { tool: "applyTextPatch", file: p.file, from: p.from, to: p.to };
            }
            break;
        }
        if (toolCall) {
          storedPatches.push({
            id: crypto.randomUUID(),
            toolCall,
            dependsOn: relevantIds,
            enabled: false,
            createdAt: (/* @__PURE__ */ new Date()).toISOString(),
            title
          });
        }
      }
      return storedPatches;
    }
  };

  // src/core/PatchManager.ts
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }
  var PatchManager = class {
    // ТЕЗИС: Все изменения применяются через безопасные DOM-операции, fallback на текстовый патч — только в крайнем случае.
    static applyToolCalls(toolCalls) {
      for (const call of toolCalls) {
        try {
          if (call.tool === "setTextContent") {
            const el = document.querySelector(call.selector);
            if (el) el.textContent = call.text;
          } else if (call.tool === "setAttribute") {
            const el = document.querySelector(call.selector);
            if (el) el.setAttribute(call.name, call.value);
          } else if (call.tool === "insertAdjacentHTML") {
            const el = document.querySelector(call.selector);
            if (el) el.insertAdjacentHTML(call.position, call.html);
          } else if (call.tool === "addStyleRule") {
            const style = document.createElement("style");
            style.textContent = `${call.selector} { ${call.style} }`;
            document.head.appendChild(style);
          } else if (call.tool === "removeElement") {
            const el = document.querySelector(call.selector);
            if (el) el.remove();
          } else if (call.tool === "wrapElement") {
            const el = document.querySelector(call.selector);
            if (el && el.parentNode) {
              const wrapper = document.createElement(call.wrapperTag);
              if (call.wrapperClass) wrapper.className = call.wrapperClass;
              el.parentNode.replaceChild(wrapper, el);
              wrapper.appendChild(el);
            }
          } else if (call.tool === "applyTextPatch") {
            const originalsRaw = localStorage.getItem("hypoAssistantOriginals");
            if (!originalsRaw) continue;
            const originals = JSON.parse(originalsRaw);
            const patched = this.applyTextPatch(originals, call);
            const htmlSource = patched["HTML_DOC"];
            if (htmlSource) {
              document.open();
              document.write(htmlSource.content);
              document.close();
            }
          }
        } catch (e) {
          console.error("Failed to apply tool:", call, e);
        }
      }
    }
    static applyTextPatch(sources, patch) {
      const patched = deepClone(sources);
      const file = patched[patch.file];
      if (!file) return patched;
      const fullFrom = file.signatureStart + patch.from + file.signatureEnd;
      const fullTo = file.signatureStart + patch.to + file.signatureEnd;
      if (file.content.includes(fullFrom)) {
        file.content = file.content.replace(fullFrom, fullTo);
      }
      return patched;
    }
  };

  // src/utils/AdaptiveProgressObserver.ts
  var AdaptiveProgressObserver = class _AdaptiveProgressObserver {
    _onProgress;
    _totalSteps;
    _stepTimeMs;
    _currentStepIndex = 0;
    _currentStepRemainingMs = void 0;
    _currentAction = "";
    constructor(onProgress, config) {
      this._onProgress = onProgress;
      this._totalSteps = config?.steps ?? 1;
      this._stepTimeMs = config?.stepTimeMs ?? 6e4;
    }
    /**
     * Создаёт дочерний поток прогресса.
     * Все обновления от дочернего флоу будут автоматически
     * агрегированы с текущим действием и оставшимся временем.
     */
    startFlow(config) {
      const wrappedOnProgress = (childUpdate) => {
        if (!this._onProgress) return;
        const fullPath = [this._currentAction, ...childUpdate.path];
        const myRemaining = this._computeRemainingMs();
        const totalRemaining = myRemaining + childUpdate.remainingMs;
        this._onProgress({ path: fullPath, remainingMs: totalRemaining });
      };
      return new _AdaptiveProgressObserver(wrappedOnProgress, config);
    }
    startStep(action, remainingMs) {
      this._currentAction = action;
      this._currentStepIndex++;
      this._currentStepRemainingMs = remainingMs !== void 0 ? Math.max(0, remainingMs) : void 0;
      this._notify();
    }
    /**
     * Обновляет оценку оставшегося времени для текущего шага.
     */
    updateEstimate(remainingMs) {
      if (this._currentStepIndex === 0) return;
      this._currentStepRemainingMs = Math.max(0, remainingMs);
      this._notify();
    }
    _computeRemainingMs() {
      const currentEstimate = this._currentStepRemainingMs ?? this._stepTimeMs;
      const remainingSteps = Math.max(0, this._totalSteps - this._currentStepIndex);
      return currentEstimate + remainingSteps * this._stepTimeMs;
    }
    _notify() {
      if (!this._onProgress) return;
      this._onProgress({
        path: [this._currentAction],
        remainingMs: this._computeRemainingMs()
      });
    }
  };

  // src/ui/components/ToggleButton.ts
  var ToggleButton = class {
    constructor(element) {
      this.element = element;
    }
    onClick(handler) {
      this.element.addEventListener("click", handler);
    }
    hide() {
      this.element.style.display = "none";
    }
    show() {
      this.element.style.display = "flex";
    }
  };

  // src/ui/components/ChatPanel.ts
  var ChatPanel = class {
    constructor(element) {
      this.element = element;
    }
    clear() {
      this.element.innerHTML = "";
    }
    addMessage(text, role) {
      const msg = document.createElement("div");
      msg.className = `msg ${role}`;
      msg.textContent = text;
      this.element.appendChild(msg);
      this.element.scrollTop = this.element.scrollHeight;
    }
    addMessageWidget(element, role) {
      const msg = document.createElement("div");
      msg.className = `msg ${role}`;
      msg.appendChild(element);
      this.element.appendChild(msg);
    }
    getElement() {
      return this.element;
    }
  };

  // src/ui/components/ProgressTree.ts
  var ProgressTree = class {
    container;
    treeLinesContainer;
    // ← контейнер только для строк дерева
    lineTemplate;
    headerTemplate = null;
    rootNodes = [];
    nodeMap = /* @__PURE__ */ new Map();
    activeNode = null;
    activeRemainingMs = 0;
    constructor(parent, lineTemplate, headerTemplate = null, userQuery) {
      this.container = document.createElement("div");
      this.container.className = "progress-tree";
      if (userQuery && headerTemplate) {
        const frag = document.importNode(headerTemplate.content, true);
        const headerEl = frag.firstElementChild;
        headerEl.textContent = userQuery;
        this.container.appendChild(headerEl);
      }
      this.treeLinesContainer = document.createElement("div");
      this.treeLinesContainer.className = "progress-tree-lines";
      this.container.appendChild(this.treeLinesContainer);
      parent.appendChild(this.container);
      this.lineTemplate = lineTemplate;
      this.headerTemplate = headerTemplate;
    }
    getKey(path) {
      return path.join("\0");
    }
    getOrCreateNode(path, now) {
      const key = this.getKey(path);
      if (this.nodeMap.has(key)) {
        return this.nodeMap.get(key);
      }
      const name = path[path.length - 1];
      const node = {
        name,
        path: [...path],
        startTime: now,
        duration: null,
        children: [],
        parent: null
      };
      if (path.length === 1) {
        this.rootNodes.push(node);
      } else {
        const parentPath = path.slice(0, -1);
        const parent = this.getOrCreateNode(parentPath, now);
        node.parent = parent;
        parent.children.push(node);
      }
      this.nodeMap.set(key, node);
      return node;
    }
    render(currentPath, remainingMs) {
      const now = Date.now();
      const currentKey = this.getKey(currentPath);
      if (this.activeNode && this.activeNode.path.join("\0") !== currentKey) {
        const isActiveAncestor = currentPath.length > this.activeNode.path.length && currentPath.slice(0, this.activeNode.path.length).every((seg, i) => seg === this.activeNode.path[i]);
        if (!isActiveAncestor) {
          this.activeNode.duration = now - this.activeNode.startTime;
        }
      }
      const currentNode = this.getOrCreateNode(currentPath, now);
      this.activeNode = currentNode;
      this.activeRemainingMs = remainingMs;
      this.renderTree();
    }
    renderTree() {
      this.clearAllTimers();
      this.treeLinesContainer.innerHTML = "";
      const renderNodes = (nodes, depth) => {
        for (const node of nodes) {
          this.renderNode(node, depth);
          if (node.children.length > 0) {
            renderNodes(node.children, depth + 1);
          }
        }
      };
      renderNodes(this.rootNodes, 0);
    }
    renderNode(node, depth) {
      const frag = document.importNode(this.lineTemplate.content, true);
      const line = frag.firstElementChild;
      const skeleton = line.querySelector(".tree-skeleton");
      const textEl = line.querySelector(".action-text");
      const timerEl = line.querySelector(".action-timer");
      let prefix = "";
      if (depth > 0) {
        prefix = "   ".repeat(depth - 1) + "\u2514\u2500 ";
      }
      skeleton.textContent = prefix;
      textEl.textContent = node.name;
      if (node === this.activeNode) {
        this.startCountdown(timerEl, this.activeRemainingMs);
      } else if (node.duration !== null) {
        const sec = Math.ceil(node.duration / 1e3);
        timerEl.textContent = `${sec}s`;
        timerEl.className = "action-timer completed";
      } else {
        timerEl.textContent = "";
        timerEl.className = "action-timer";
      }
      this.treeLinesContainer.appendChild(frag);
    }
    startCountdown(timerEl, msLeft) {
      const tick = () => {
        if (msLeft <= 0) {
          timerEl.textContent = "\u2713";
          timerEl.className = "action-timer completed";
          timerEl.removeAttribute("data-interval-id");
          return;
        }
        const totalSec = Math.ceil(msLeft / 1e3);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor(totalSec % 3600 / 60);
        const s = totalSec % 60;
        const parts = [];
        if (h > 0) parts.push(String(h).padStart(2, "0"));
        parts.push(String(m).padStart(2, "0"));
        parts.push(String(s).padStart(2, "0"));
        timerEl.textContent = parts.join(":");
        msLeft -= 1e3;
      };
      tick();
      const intervalId = setInterval(tick, 1e3);
      timerEl.setAttribute("data-interval-id", String(intervalId));
    }
    clearAllTimers() {
      const timers = this.container.querySelectorAll(".action-timer[data-interval-id]");
      timers.forEach((el) => {
        const id = el.getAttribute("data-interval-id");
        if (id) {
          clearInterval(Number(id));
          el.removeAttribute("data-interval-id");
        }
      });
    }
    freeze() {
      this.clearAllTimers();
      this.activeNode = null;
      if (this.rootNodes.length > 0) {
        const lastNode = this._getLastNode();
        if (lastNode && lastNode.duration === null) {
          lastNode.duration = Date.now() - lastNode.startTime;
        }
      }
      this.renderTree();
    }
    _getLastNode() {
      let node = null;
      const findLast = (nodes) => {
        if (nodes.length === 0) return;
        const last = nodes[nodes.length - 1];
        node = last;
        if (last.children.length > 0) {
          findLast(last.children);
        }
      };
      findLast(this.rootNodes);
      return node;
    }
    clear() {
      this.clearAllTimers();
      this.rootNodes = [];
      this.nodeMap.clear();
      this.activeNode = null;
      this.treeLinesContainer.innerHTML = "";
    }
    destroy() {
      this.clear();
      this.container.remove();
    }
    getElement() {
      return this.container;
    }
  };

  // src/ui/components/PatchListView.ts
  var PatchListView = class {
    constructor(chatPanel, patchItemTemplate, patchWidgetTemplate, storage, onFrozen) {
      this.chatPanel = chatPanel;
      this.patchItemTemplate = patchItemTemplate;
      this.patchWidgetTemplate = patchWidgetTemplate;
      this.storage = storage;
      this.onFrozen = onFrozen;
    }
    show() {
      const frag = document.importNode(this.patchWidgetTemplate.content, true);
      const widget = frag.firstElementChild;
      const listContainer = widget.querySelector(".hypo-patch-list");
      const emptyEl = widget.querySelector(".hypo-patch-empty");
      const saveBtn = widget.querySelector(".hypo-patch-save-btn");
      const patches = this.storage.getPatches();
      if (patches.length === 0) {
        emptyEl.style.display = "block";
        saveBtn.style.display = "none";
      } else {
        emptyEl.style.display = "none";
        saveBtn.style.display = "block";
        patches.forEach((p) => {
          const itemFrag = document.importNode(this.patchItemTemplate.content, true);
          const checkbox = itemFrag.querySelector("input");
          const titleSpan = itemFrag.querySelector("span");
          const dateEl = itemFrag.querySelector("small");
          checkbox.dataset.id = p.id;
          checkbox.checked = p.enabled;
          titleSpan.textContent = p.title;
          titleSpan.title = p.id;
          dateEl.textContent = new Date(p.createdAt).toLocaleDateString();
          checkbox.addEventListener("change", () => {
            const id = checkbox.dataset.id;
            if (!id) return;
            const current = this.storage.getPatches();
            const updated = current.map((pp) => pp.id === id ? { ...pp, enabled: checkbox.checked } : pp);
            this.storage.savePatches(updated);
            if (checkbox.checked) {
              const patch = updated.find((pp) => pp.id === id);
              PatchManager.applyToolCalls([patch.toolCall]);
            }
          });
          listContainer.appendChild(itemFrag);
        });
        saveBtn.onclick = () => {
          widget.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
            cb.disabled = true;
          });
          saveBtn.remove();
          this.onFrozen?.();
        };
      }
      this.chatPanel.addMessageWidget(widget, "assist");
    }
  };

  // src/ui/components/ConfigModal.ts
  var ConfigModal = class {
    constructor(storage, chatPanel) {
      this.storage = storage;
      this.chatPanel = chatPanel;
    }
    show() {
      const configRaw = localStorage.getItem("hypoAssistantConfig");
      let config = configRaw ? JSON.parse(configRaw) : {};
      if (config.apiKey !== void 0 || config.apiEndpoint !== void 0 || config.model !== void 0) {
        config = {
          llm: {
            apiKey: config.apiKey,
            apiEndpoint: config.apiEndpoint,
            model: config.model
          }
        };
      }
      const llm = config.llm || {};
      const ep = prompt("API Endpoint:", llm.apiEndpoint || "https://openrouter.ai/api/v1/chat/completions") || llm.apiEndpoint;
      const key = prompt("API Key:") || llm.apiKey;
      const model = prompt("Model:", llm.model || "tngtech/deepseek-r1t2-chimera:free") || llm.model;
      const newConfig = {
        llm: { apiEndpoint: ep, apiKey: key, model }
      };
      localStorage.setItem("hypoAssistantConfig", JSON.stringify(newConfig));
      this.chatPanel.addMessage("\u2705 Config saved.", "assist");
      if (key && key !== llm.apiKey) {
        localStorage.removeItem("hypoAssistantSemanticIndex");
        this.chatPanel.addMessage("\u{1F504} Semantic index will be rebuilt on next request.", "assist");
      }
    }
  };

  // src/ui/components/ExportHandler.ts
  var ExportHandler = class {
    export() {
      const clonedDoc = document.cloneNode(true);
      const script = clonedDoc.querySelector('script[src="./HypoAssistant.js"]');
      if (script) script.remove();
      clonedDoc.querySelectorAll("script:not([src]):not([id])").forEach((el) => {
        if (el.textContent?.includes("hashLang")) el.remove();
      });
      const core = clonedDoc.getElementById("hypo-assistant-core");
      if (core) core.remove();
      const blob = new Blob([`<!DOCTYPE html>
${clonedDoc.documentElement.outerHTML}`], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "patched-page.html";
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  // src/ui/index.html
  var ui_default = '<!-- \u{1F99B} \u0412\u0441\u044F UI-\u0431\u0438\u0431\u043B\u0438\u043E\u0442\u0435\u043A\u0430 \u2014 \u043E\u0431\u0451\u0440\u043D\u0443\u0442\u0430 \u0434\u043B\u044F \u0438\u0437\u043E\u043B\u044F\u0446\u0438\u0438 \u0441\u0442\u0438\u043B\u0435\u0439 -->\n<div id="hypo-assistant-core">\n\n    <!-- \u{1F518} ToggleButton.ts \u2014 \u043F\u043B\u0430\u0432\u0430\u044E\u0449\u0430\u044F \u043A\u043D\u043E\u043F\u043A\u0430 \u043E\u0442\u043A\u0440\u044B\u0442\u0438\u044F -->\n    <button id="hypo-toggle" aria-label="Open HypoAssistant">\u{1F99B}</button>\n\n    <!-- \u{1F5A5}\uFE0F HypoAssistantUI.ts (\u043E\u0440\u043A\u0435\u0441\u0442\u0440\u0430\u0442\u043E\u0440) \u2014 \u0443\u043F\u0440\u0430\u0432\u043B\u044F\u0435\u0442 \u043E\u0442\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435\u043C/\u0441\u043A\u0440\u044B\u0442\u0438\u0435\u043C \u043F\u0430\u043D\u0435\u043B\u0438 -->\n    <div id="hypo-panel" style="display: none;">\n\n        <!-- \u{1F4AC} ChatPanel.ts \u2014 \u043A\u043E\u043D\u0442\u0435\u0439\u043D\u0435\u0440 \u0434\u043B\u044F \u0432\u0441\u0435\u0445 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 (user/assist), \u043F\u0440\u043E\u0433\u0440\u0435\u0441\u0441\u0430 \u0438 \u0441\u043F\u0438\u0441\u043A\u0430 \u043F\u0430\u0442\u0447\u0435\u0439 -->\n        <div class="hypo-header">\n            <div class="hypo-title">\u{1F99B} <span>HypoAssistant v1.1</span></div>\n            <!-- \u{1F518} ToggleButton.ts (\u0432\u0442\u043E\u0440\u0430\u044F \u0440\u043E\u043B\u044C) \u2014 \u043A\u043D\u043E\u043F\u043A\u0430 \u0441\u0432\u043E\u0440\u0430\u0447\u0438\u0432\u0430\u043D\u0438\u044F \u043F\u0430\u043D\u0435\u043B\u0438 -->\n            <button id="hypo-collapse" aria-label="Collapse panel">\n                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n                    <polyline points="9 18 15 12 9 6"></polyline>\n                </svg>\n            </button>\n        </div>\n\n        <!-- \u{1F4AC} ChatPanel.ts \u2014 \u043E\u0441\u043D\u043E\u0432\u043D\u043E\u0435 \u0441\u043E\u0434\u0435\u0440\u0436\u0438\u043C\u043E\u0435 \u0447\u0430\u0442\u0430 -->\n        <div id="hypo-chat"></div>\n\n        <!-- \u270D\uFE0F ChatPanel.ts \u2014 \u043D\u043E \u043E\u0431\u0440\u0430\u0431\u0430\u0442\u044B\u0432\u0430\u0435\u0442\u0441\u044F \u0432 HypoAssistantUI \u0447\u0435\u0440\u0435\u0437 sendBtn.onclick -->\n        <div class="hypo-input-area">\n            <input type="text" id="hypo-input-field" placeholder="Describe change..." />\n            <button id="hypo-send" aria-label="Send">\n                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n                    <line x1="22" y1="2" x2="11" y2="13"/>\n                    <polygon points="22 2 15 22 11 13 2 9 22 2"/>\n                </svg>\n            </button>\n            <template id="hypo-cancel-icon-template">\n                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n                    <line x1="18" y1="6" x2="6" y2="18"></line>\n                    <line x1="6" y1="6" x2="18" y2="18"></line>\n                </svg>\n            </template>\n        </div>\n\n        <!-- \u{1F6E0}\uFE0F HypoAssistantUI.ts \u2014 \u0433\u043B\u043E\u0431\u0430\u043B\u044C\u043D\u044B\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F -->\n        <div class="hypo-actions-grid">\n            <button id="hypo-export">\n                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>\n                    <polyline points="7 10 12 15 17 10"></polyline>\n                    <line x1="12" y1="15" x2="12" y2="3"></line>\n                </svg>\n                Export\n            </button>\n            <button id="hypo-patch-manager">\n                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n                    <rect x="2" y="7.5" width="20" height="9" rx="3" transform="rotate(45 12 12)" />\n                    <rect x="2" y="7.5" width="20" height="9" rx="3" transform="rotate(-45 12 12)" />\n                </svg>\n                Patches\n            </button>\n            <button id="hypo-settings">\n                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n                    <circle cx="12" cy="12" r="3"></circle>\n                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1.51-1.65 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09a1.65 1.65 0 0 0 1.51-1.65 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>\n                </svg>\n                Settings\n            </button>\n            <button id="hypo-reload">\n                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n                    <polyline points="23 4 23 10 17 10"></polyline>\n                    <polyline points="1 20 1 14 7 14"></polyline>\n                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>\n                </svg>\n                Reload\n            </button>\n        </div>\n\n    </div> <!-- /#hypo-panel -->\n\n\n    <!-- \u{1F9E9} PatchListView.ts \u2014 \u0448\u0430\u0431\u043B\u043E\u043D \u0432\u0438\u0434\u0436\u0435\u0442\u0430 \u043F\u0430\u0442\u0447\u0435\u0439 -->\n    <template id="hypo-patch-widget-template">\n        <div class="hypo-patch-widget">\n            <div class="hypo-patch-header">\u{1F9E9} Active patches</div>\n            <div class="hypo-patch-list"></div>\n            <p class="hypo-patch-empty" style="display: none; color: var(--ha-text-secondary); font-size: 13px; margin-top: 8px;">\n                No patches yet.\n            </p>\n            <button class="hypo-patch-save-btn">\u2705 Save & Freeze</button>\n        </div>\n    </template>\n    <!-- \u{1F4E6} PatchListView.ts \u2014 \u0448\u0430\u0431\u043B\u043E\u043D \u0434\u043B\u044F \u043E\u0442\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u044F \u043E\u0434\u043D\u043E\u0433\u043E \u043F\u0430\u0442\u0447\u0430 -->\n    <template id="hypo-patch-item-template">\n        <div class="hypo-patch-item">\n            <label>\n                <input type="checkbox" />\n                <span></span>\n            </label>\n            <small></small>\n        </div>\n    </template>\n\n    <!-- \u{1F333} ProgressTree.ts \u2014 \u0448\u0430\u0431\u043B\u043E\u043D \u043E\u0434\u043D\u043E\u0439 \u0441\u0442\u0440\u043E\u043A\u0438 \u043F\u0440\u043E\u0433\u0440\u0435\u0441\u0441\u0430 -->\n    <template id="hypo-progress-line-template">\n        <div class="progress-line">\n            <span class="tree-skeleton"></span>\n            <span class="action-text"></span>\n            <span class="action-timer"></span>\n        </div>\n    </template>\n\n    <template id="hypo-progress-header-template">\n        <div class="progress-header">\n            <strong></strong>\n        </div>\n    </template>\n\n</div>';

  // src/ui/styles.css
  var styles_default = `#hypo-assistant-core {
    /* --- \u041A\u0430\u0441\u0442\u043E\u043C\u0438\u0437\u0430\u0446\u0438\u044F \u0447\u0435\u0440\u0435\u0437 CSS vars --- */
    --ha-space-xs: 4px;
    --ha-space-s: 8px;
    --ha-space-m: 12px;
    --ha-space-l: 16px;
    --ha-space-xl: 20px;

    --ha-radius-s: 8px;
    --ha-radius-m: 12px;
    --ha-radius-l: 16px;
    --ha-radius-full: 50%;

    --ha-btn-size: 40px;
    --ha-panel-width: 360px;

    /* \u0426\u0432\u0435\u0442\u0430 \u2014 \u0441\u0432\u0435\u0442\u043B\u0430\u044F \u0442\u0435\u043C\u0430 \u043F\u043E \u0443\u043C\u043E\u043B\u0447\u0430\u043D\u0438\u044E */
    --ha-bg: #ffffff;
    --ha-surface: #ffffff;
    --ha-text: #111111;
    --ha-text-secondary: #666666;
    --ha-border: #e0e0e0;
    --ha-brand: #6c63ff;
    --ha-user-bg: #e6e6ff;
    --ha-coach-bg: #f0f0f0;
    --ha-shadow: 0 6px 16px rgba(0,0,0,0.08);
    --ha-shadow-toggle: 0 4px 12px rgba(0,0,0,0.12);
}

@media (prefers-color-scheme: dark) {
    #hypo-assistant-core {
        --ha-bg: #121212;
        --ha-surface: #1e1e1e;
        --ha-text: #e0e0e0;
        --ha-text-secondary: #a0a0a0;
        --ha-border: #333333;
        --ha-user-bg: #2a273f;
        --ha-coach-bg: #2d2d2d;
    }
}

#hypo-assistant-core *,
#hypo-assistant-core *::before,
#hypo-assistant-core *::after {
    box-sizing: border-box;
}

/* Toggle button (floating) */
#hypo-assistant-core #hypo-toggle {
    position: fixed;
    bottom: var(--ha-space-l);
    right: var(--ha-space-l);
    width: var(--ha-btn-size);
    height: var(--ha-btn-size);
    background: var(--ha-brand);
    color: white;
    border-radius: var(--ha-radius-full);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    z-index: 10000;
    box-shadow: var(--ha-shadow-toggle);
    border: none;
    padding: 0;
    font: inherit;
}

/* Main panel */
#hypo-assistant-core #hypo-panel {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    max-width: var(--ha-panel-width);
    background: var(--ha-bg);
    color: var(--ha-text);
    font-family: 'Inter', system-ui, sans-serif;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    box-shadow: -2px 0 12px rgba(0,0,0,0.08);
    overflow: hidden;
}

/* Header */
#hypo-assistant-core .hypo-header {
    padding: var(--ha-space-m);
    background: var(--ha-surface);
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--ha-border);
}

#hypo-assistant-core .hypo-title {
    font-weight: 600;
    font-size: 16px;
    display: flex;
    align-items: center;
    gap: var(--ha-space-xs);
}

#hypo-assistant-core #hypo-collapse {
    background: none;
    color: var(--ha-text-secondary);
    border: none;
    width: 24px;
    height: 24px;
    border-radius: var(--ha-radius-full);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    font: inherit;
}

/* Chat */
#hypo-assistant-core #hypo-chat {
    flex: 1;
    overflow-y: auto;
    padding: var(--ha-space-l);
    font-size: 14px;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: var(--ha-space-m);
}

/* Input area */
#hypo-assistant-core .hypo-input-area {
    padding: var(--ha-space-m) var(--ha-space-l) var(--ha-space-l);
    background: var(--ha-surface);
    display: flex;
    gap: var(--ha-space-s);
}

#hypo-assistant-core #hypo-input-field {
    flex: 1;
    background: var(--ha-surface);
    color: var(--ha-text);
    border: 1px solid var(--ha-border);
    border-radius: var(--ha-radius-m);
    padding: var(--ha-space-s) var(--ha-space-m);
    font-family: inherit;
    font-size: 14px;
}

#hypo-assistant-core #hypo-send {
    width: var(--ha-btn-size);
    height: var(--ha-btn-size);
    background: var(--ha-brand);
    color: white;
    border: none;
    border-radius: var(--ha-radius-full);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
}

/* Action buttons grid */
#hypo-assistant-core .hypo-actions-grid {
    padding: 0 var(--ha-space-l) var(--ha-space-l);
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--ha-space-s);
}

#hypo-assistant-core .hypo-actions-grid button {
    padding: var(--ha-space-s);
    background: var(--ha-surface);
    border: 1px solid var(--ha-border);
    border-radius: var(--ha-radius-m);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--ha-space-xs);
    font-size: 12px;
    color: var(--ha-text);
}

/* Patch item (from template) */
#hypo-assistant-core .hypo-patch-item {
    padding: var(--ha-space-m);
    background: var(--ha-surface);
    border-radius: var(--ha-radius-m);
    border: 1px solid var(--ha-border);
}

#hypo-assistant-core .hypo-patch-item label {
    display: flex;
    align-items: center;
    gap: var(--ha-space-s);
}

#hypo-assistant-core .hypo-patch-item input[type="checkbox"] {
    width: 16px;
    height: 16px;
}

#hypo-assistant-core .hypo-patch-item span {
    color: var(--ha-text);
    font-weight: 500;
}

#hypo-assistant-core .hypo-patch-item small {
    color: var(--ha-text-secondary);
    font-size: 11px;
    margin-top: var(--ha-space-xs);
    display: block;
}

/* Progress tree (used dynamically) */
.progress-tree {
    background: var(--ha-coach-bg);
    border-radius: var(--ha-radius-m);
    padding: var(--ha-space-s) var(--ha-space-m); /* \u043A\u0430\u043A \u0443 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0439 */
    font-family: monospace;
    font-size: 14px;
    line-height: 1.4;
    margin: var(--ha-space-s) 0; /* \u043D\u0435\u0431\u043E\u043B\u044C\u0448\u043E\u0439 \u0432\u0435\u0440\u0442\u0438\u043A\u0430\u043B\u044C\u043D\u044B\u0439 \u043E\u0442\u0441\u0442\u0443\u043F */
}

.progress-line {
    display: flex;
    align-items: baseline;
}

.progress-line .tree-skeleton {
    opacity: 0.7;
    user-select: none;
    white-space: pre;
    min-width: 24px;
}

.progress-line .action-text {
    margin-right: 8px;
}

.progress-line .action-timer {
    font-family: monospace;
    font-size: 12px;
    color: var(--ha-text-secondary);
    min-width: 48px;
    text-align: right;
}

.progress-line .action-timer.completed {
    color: var(--ha-brand);
}

.progress-header {
    padding: var(--ha-space-s) var(--ha-space-m);
    font-weight: 600;
    color: var(--ha-text);
    /*border-bottom: 1px solid var(--ha-border);*/
    margin: 0 calc(-1 * var(--ha-space-l));
}

/* Chat messages */
#hypo-assistant-core .msg.user {
    background: var(--ha-user-bg);
    padding: var(--ha-space-s) var(--ha-space-m);
    border-radius: var(--ha-radius-s);
    align-self: flex-end;
}

#hypo-assistant-core .msg.assist {
    background: var(--ha-coach-bg);
    padding: var(--ha-space-s) var(--ha-space-m);
    border-radius: var(--ha-radius-s);
    align-self: flex-start;
}

/* \u0412\u0438\u0434\u0436\u0435\u0442 \u043F\u0430\u0442\u0447\u0435\u0439 \u043A\u0430\u043A \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 */
.hypo-patch-widget {
    width: 100%;
    padding: var(--ha-space-s) var(--ha-space-m);
    background: var(--ha-surface);
    border-radius: var(--ha-radius-m);
    border: 1px solid var(--ha-border);
    font-size: 13px;
}

.hypo-patch-header {
    font-weight: 600;
    margin-bottom: var(--ha-space-s);
    color: var(--ha-text);
    display: flex;
    align-items: center;
    gap: var(--ha-space-xs);
}

.hypo-patch-list {
    display: flex;
    flex-direction: column;
    gap: var(--ha-space-s);
}

.hypo-patch-save-btn {
    margin-top: var(--ha-space-m);
    padding: var(--ha-space-xs) var(--ha-space-s);
    background: var(--ha-brand);
    color: white;
    border: none;
    border-radius: var(--ha-radius-s);
    font-size: 12px;
    cursor: pointer;
}

.hypo-patch-save-btn:hover {
    opacity: 0.9;
}`;

  // src/ui/UI.ts
  var HypoAssistantUI = class {
    constructor(onUserRequest, storage) {
      this.onUserRequest = onUserRequest;
      this.storage = storage;
    }
    panel = null;
    abortController = null;
    toggleButton;
    chatPanel;
    progressTree = null;
    show() {
      if (this.panel) return;
      this.injectStyles();
      this.injectMarkup();
      const elements = this.getUIElements();
      this.panel = elements.panelEl;
      this.initializeComponents(elements);
      this.bindGlobalActions(elements);
      this.setupChatAndPatches(elements);
      this.setupInputHandling(elements);
      this.showInitialMessage();
    }
    // === Вспомогательные методы ===
    injectStyles() {
      if (!document.getElementById("hypo-assistant-styles")) {
        const style = document.createElement("style");
        style.id = "hypo-assistant-styles";
        style.textContent = styles_default;
        document.head.appendChild(style);
      }
    }
    injectMarkup() {
      const frag = document.createRange().createContextualFragment(ui_default);
      document.body.appendChild(frag);
    }
    getUIElements() {
      const panelEl = document.getElementById("hypo-panel");
      const toggleEl = document.getElementById("hypo-toggle");
      const chatEl = document.getElementById("hypo-chat");
      const patchItemTpl = document.getElementById("hypo-patch-item-template");
      const progressLineTpl = document.getElementById("hypo-progress-line-template");
      const progressHeaderTpl = document.getElementById("hypo-progress-header-template");
      const cancelIconTpl = document.getElementById("hypo-cancel-icon-template");
      const sendBtn = document.getElementById("hypo-send");
      const inputField = document.getElementById("hypo-input-field");
      return {
        panelEl,
        toggleEl,
        chatEl,
        patchItemTpl,
        progressLineTpl,
        progressHeaderTpl,
        cancelIconTpl,
        sendBtn,
        inputField
      };
    }
    initializeComponents(elements) {
      this.toggleButton = new ToggleButton(elements.toggleEl);
      this.chatPanel = new ChatPanel(elements.chatEl);
    }
    bindGlobalActions(elements) {
      const { panelEl } = elements;
      this.toggleButton.onClick(() => {
        this.toggleButton.hide();
        panelEl.style.display = "flex";
      });
      document.getElementById("hypo-collapse").onclick = () => {
        panelEl.style.display = "none";
        this.toggleButton.show();
      };
      document.getElementById("hypo-reload").onclick = () => location.reload();
    }
    setupChatAndPatches(elements) {
      const { chatEl, patchItemTpl } = elements;
      const showMainChat = () => {
        this.chatPanel.clear();
        this.chatPanel.addMessage("\u{1F99B} Ready. Describe your change.", "assist");
      };
      const patchList = new PatchListView(
        this.chatPanel,
        patchItemTpl,
        document.getElementById("hypo-patch-widget-template"),
        // ← новый шаблон
        this.storage,
        () => {
          this.chatPanel.addMessage(
            "\u2705 Patch settings saved. Changes will persist after reload.",
            "assist"
          );
        }
      );
      document.getElementById("hypo-patch-manager").onclick = () => {
        patchList.show();
      };
      const configModal = new ConfigModal(this.storage, this.chatPanel);
      document.getElementById("hypo-settings").onclick = () => {
        configModal.show();
      };
      const exportHandler = new ExportHandler();
      document.getElementById("hypo-export").onclick = () => {
        exportHandler.export();
      };
    }
    setupInputHandling(elements) {
      const { sendBtn, inputField, chatEl, progressLineTpl, progressHeaderTpl, cancelIconTpl } = elements;
      const originalSendIcon = sendBtn.innerHTML;
      const setSendButtonState = (isWorking) => {
        if (isWorking) {
          sendBtn.innerHTML = "";
          sendBtn.appendChild(document.importNode(cancelIconTpl.content, true));
          sendBtn.setAttribute("aria-label", "Cancel");
        } else {
          sendBtn.innerHTML = originalSendIcon;
          sendBtn.setAttribute("aria-label", "Send");
        }
      };
      const handleSend = async () => {
        const query = inputField.value.trim();
        if (!query) return;
        inputField.value = "";
        this.chatPanel.addMessage(query, "user");
        this.progressTree = null;
        this.abortController?.abort();
        this.abortController = new AbortController();
        setSendButtonState(true);
        const progress = new AdaptiveProgressObserver((update) => {
          if (!this.progressTree) {
            this.progressTree = new ProgressTree(
              chatEl,
              progressLineTpl,
              progressHeaderTpl,
              query
            );
          }
          this.progressTree.render(update.path, update.remainingMs);
          this.progressTree.getElement().scrollIntoView({ behavior: "smooth" });
        });
        try {
          const result = await this.onUserRequest(query, progress, this.abortController.signal);
          this.progressTree?.freeze();
          setSendButtonState(false);
          this.chatPanel.addMessage(result.groupTitle, "assist");
          if (confirm("Apply patch?")) {
            const existing = this.storage.getPatches();
            const updated = [...existing, ...result.patches];
            PatchManager.applyToolCalls(result.patches.map((p) => p.toolCall));
            this.storage.savePatches(updated);
            this.chatPanel.addMessage('\u2705 Applied. Enable in "\u{1F9E9} Patches" to persist.', "assist");
          }
        } catch (err) {
          this.progressTree?.freeze();
          setSendButtonState(false);
          if (err.name !== "AbortError") {
            this.chatPanel.addMessage(`\u274C ${err.message}`, "assist");
          }
        }
      };
      sendBtn.onclick = () => {
        if (sendBtn.innerHTML !== originalSendIcon) {
          this.abortController?.abort();
          this.progressTree?.freeze();
          setSendButtonState(false);
        } else {
          handleSend();
        }
      };
      inputField.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey) {
          e.preventDefault();
          if (sendBtn.innerHTML === originalSendIcon) {
            handleSend();
          }
        }
      });
    }
    showInitialMessage() {
      this.chatPanel.addMessage("\u{1F99B} Ready. Describe your change.", "assist");
    }
  };

  // src/main.ts
  (async () => {
    "use strict";
    if (document.getElementById("hypo-assistant-core")) {
      console.warn("[HypoAssistant] Already initialized. Skipping.");
      return;
    }
    const config = new AppConfig();
    await config.init();
    const storage = new StorageAdapter();
    const llm = new LLMClient(config, storage);
    const engine = new HypoAssistantEngine(config, storage, llm);
    const savedPatches = storage.getPatches();
    const enabledPatches = savedPatches.filter((p) => p.enabled);
    if (enabledPatches.length > 0) {
      PatchManager.applyToolCalls(enabledPatches.map((p) => p.toolCall));
    }
    const ui = new HypoAssistantUI(
      async (query, progress, signal) => await engine.run(query, progress, signal),
      storage
    );
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => ui.show());
    } else {
      ui.show();
    }
  })();
})();
