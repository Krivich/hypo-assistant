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
    // === Запуск чанкинга ===
    static async handleChunkedInference(originalSystemPrompt, originalUserPrompt, maxTokens, usedTokens, context, llmClient, signal) {
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
            const result = await llmClient.call(
              messages,
              contextWithEstimate,
              signal,
              (err) => _ChunkedLlmSupport.isContextOverflowError(err) !== null
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
      const finalSystemPrompt = this.buildFinalSystemPrompt(originalSystemPrompt, intermediateResults);
      const finalMessages = [
        { role: "system", content: finalSystemPrompt },
        { role: "user", content: "[BEGIN AGGREGATED RESULTS]" }
      ];
      return await llmClient.call(finalMessages, `${context}:final_aggregation`, signal);
    }
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
    async call(messages, context, signal, isNonRetryableError) {
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
              // ← КЛЮЧЕВОЕ ИЗМЕНЕНИЕ
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
                  signal
                );
              }
            }
            throw new Error(`LLM Error: ${data.error.message}`);
          }
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
    async validateAndReindexChunk(fileId, currentMeta, oldIndexEntry, relevantPatches) {
      let systemPromptContent = "";
      if (currentMeta.type === "html") {
        systemPromptContent = CORE_INSTRUCTIONS + HTML_SPECIFIC + RESPONSE_FORMAT + STRICT_RULES;
      } else if (currentMeta.type === "js") {
        systemPromptContent = CORE_INSTRUCTIONS + JS_SPECIFIC + RESPONSE_FORMAT + STRICT_RULES;
      } else if (currentMeta.type === "css") {
        systemPromptContent = CORE_INSTRUCTIONS + CSS_SPECIFIC + RESPONSE_FORMAT + STRICT_RULES;
      } else {
        systemPromptContent = CORE_INSTRUCTIONS + `
Focus on the semantic meaning and structure of the content.
` + RESPONSE_FORMAT + STRICT_RULES;
      }
      const validationPrompt = {
        role: "system",
        content: `The content of file "${fileId}" has changed.
Old index entry:
${JSON.stringify(oldIndexEntry, null, 2)}

Active patches that depend on this file:
${JSON.stringify(relevantPatches, null, 2)}

Please:
1. Generate a new index for this file (same format as before).
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
      const response = await this.llm.call([validationPrompt, userPrompt], `validate_reindex:${fileId}`);
      return response;
    }
    async ensureIndex() {
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
        const storedHash = typeof stored === "object" && stored !== null && "hash" in stored ? stored.hash : void 0;
        if (!stored || storedHash !== meta.hash || isFallbackIndex(stored)) {
          try {
            if (stored && storedHash !== meta.hash) {
              const allPatches = this.storage.getPatches();
              const relevantPatches = allPatches.filter((p) => p.dependsOn.includes(fileId));
              const result = await this.validateAndReindexChunk(fileId, meta, stored, relevantPatches);
              semanticIndex[fileId] = { ...result.newIndex, hash: meta.hash };
              if (result.validatedPatches && result.validatedPatches.length > 0) {
                const patchesMap = new Map(result.validatedPatches.map((v) => [v.id, v.valid]));
                const updatedPatches = allPatches.map((p) => {
                  if (patchesMap.has(p.id)) {
                    return { ...p, enabled: patchesMap.get(p.id) === true && p.enabled };
                  }
                  return p;
                });
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
              const rawSummary = await this.llm.call([systemPrompt, userPrompt], `indexing:${fileId}`);
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

  // src/core/Engine.ts
  var HypoAssistantEngine = class {
    constructor(config, storage, llm) {
      this.config = config;
      this.storage = storage;
      this.llm = llm;
    }
    async run(userQuery, signal) {
      const { originals, index: semanticIndex } = await new SemanticIndexer(this.config, this.storage, this.llm).ensureIndex();
      console.group(`[HypoAssistant] \u{1F680} New request: "${userQuery}"`);
      const activePatches = this.storage.getPatches().filter((p) => p.enabled);
      const activePatchesSummary = activePatches.length > 0 ? activePatches.map((p) => `- ${p.title}`).join("\n") : "None";
      const relevancePrompt = {
        role: "system",
        content: `Project structure:
${JSON.stringify(semanticIndex, null, 2)}

Currently active patches (already applied to the page):
${activePatchesSummary}

Note: Applied patches are user-controlled and may be disabled at any time. Do not assume their effects are permanent.

Return {"relevant": ["file_id"]}`
      };
      const userRelevanceMsg = {
        role: "user",
        content: userQuery
      };
      const relevanceRes = await this.llm.call([relevancePrompt, userRelevanceMsg], "relevance", signal);
      const relevantIds = relevanceRes.relevant || ["HTML_DOC"];
      console.log("\u{1F4C1} Relevant files:", relevantIds);
      const contextBlocks = relevantIds.map((id) => {
        const src = originals[id];
        return src ? `[FILE: ${id}]
${src.content}
[/FILE]` : "";
      }).filter(Boolean).join("\n\n");
      const patchPrompt = {
        role: "system",
        content: `You are a precise frontend editor. Fulfill the user request by generating **one or more tools** in the correct order.

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
      "title": "Short, human-readable description of this change (max 60 characters, e.g. 'Add \u{1F99B} to heading')"
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
- \u2705 **NEVER use \`applyTextPatch\` for styles, text content, or standard HTML elements**.
- \u2705 **For CSS changes \u2192 ALWAYS use \`addStyleRule\`**.
- \u2705 **For text changes \u2192 ALWAYS use \`setTextContent\` or \`insertAdjacentHTML\`**.
- \u2705 **For attribute changes \u2192 ALWAYS use \`setAttribute\`**.
- \u26A0\uFE0F **Only use \`applyTextPatch\` as a last resort** when:
    - the target is inside a \`<script>\` or \`<template>\` tag,
    - and no DOM selector can be used to modify it incrementally.
- \u{1F6AB} **Never use \`applyTextPatch\` on \`HTML_DOC\` unless it's the only way to fix broken markup that cannot be addressed via DOM APIs**.
- Order matters: apply patches in the exact sequence provided.
- Every patch must have a concise, meaningful "title" (max 60 characters).
- "groupTitle" must be \u2264 80 characters and describe the whole intent.
- NEVER generate JavaScript code or use eval.
- Return ONLY valid JSON. No markdown, no explanation.`
      };
      const userPatchMsg = {
        role: "user",
        content: `Context:
${contextBlocks}

User request: ${userQuery}`
      };
      const patchRes = await this.llm.call([patchPrompt, userPatchMsg], "patch", signal);
      let groupTitle = "Untitled change";
      if (typeof patchRes.groupTitle === "string") {
        groupTitle = patchRes.groupTitle.substring(0, 80);
      }
      const rawPatches = Array.isArray(patchRes.patches) ? patchRes.patches : [patchRes];
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
                toolCall = { tool: "insertAdjacentHTML", selector: p.selector, position: pos, html: p.html };
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
              toolCall = { tool: "wrapElement", selector: p.selector, wrapperTag: p.wrapperTag, wrapperClass: p.wrapperClass };
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
      if (storedPatches.length === 0) {
        throw new Error("No valid patches generated");
      }
      console.log("\u{1F3C6} Generated group:", { groupTitle, patches: storedPatches });
      const diagnostics = this.storage.getDiagnostics();
      diagnostics.runs.push({
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        phase: "final_tool_call",
        data: { groupTitle, patches: storedPatches }
        // ✅ исправлено: объект соответствует Diagnostics
      });
      this.storage.saveDiagnostics(diagnostics);
      console.groupEnd();
      return {
        message: groupTitle,
        patches: storedPatches,
        groupTitle
      };
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

  // src/ui/UI.ts
  var HypoAssistantUI = class {
    constructor(onUserRequest, storage) {
      this.onUserRequest = onUserRequest;
      this.storage = storage;
    }
    panel = null;
    abortController = null;
    patchItemTemplate = null;
    getTemplate() {
      return `
<style>
  #hypo-assistant-core {
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
</style>

<!-- Toggle button -->
<button id="hypo-toggle" aria-label="Open HypoAssistant" style="
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
">\u{1F99B}</button>

<!-- Main panel -->
<div id="hypo-panel" style="
  display: none;
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
  flex-direction: column;
  box-shadow: -2px 0 12px rgba(0,0,0,0.08);
  overflow: hidden;
">
  <div style="padding: var(--ha-space-m); background: var(--ha-surface); display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--ha-border);">
    <div style="font-weight: 600; font-size: 16px; display: flex; align-items: center; gap: var(--ha-space-xs);">
      \u{1F99B} <span>HypoAssistant v1.1</span>
    </div>
    <button id="hypo-collapse" aria-label="Collapse panel" style="
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
    ">
      <!-- collapse icon (chevron left) -->
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="15 18 9 12 15 6"></polyline>
      </svg>
    </button>
  </div>

  <div id="hypo-chat" style="
    flex: 1;
    overflow-y: auto;
    padding: var(--ha-space-l);
    font-size: 14px;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: var(--ha-space-m);
  "></div>

  <div style="padding: var(--ha-space-m) var(--ha-space-l) var(--ha-space-l); background: var(--ha-surface);">
    <div style="display: flex; gap: var(--ha-space-s);">
      <input type="text" placeholder="Describe change..." id="hypo-input-field" style="
        flex: 1;
        background: var(--ha-surface);
        color: var(--ha-text);
        border: 1px solid var(--ha-border);
        border-radius: var(--ha-radius-m);
        padding: var(--ha-space-s) var(--ha-space-m);
        font-family: inherit;
        font-size: 14px;
      ">
      <button id="hypo-send" aria-label="Send" style="
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
      ">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/>
          <polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
    </div>
  </div>

  <div style="padding: 0 var(--ha-space-l) var(--ha-space-l); display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--ha-space-s);">
    <button id="hypo-export" style="
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
    ">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      Export
    </button>
    <button id="hypo-patch-manager" style="
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
    ">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="8" y1="6" x2="21" y2="6"></line>
        <line x1="8" y1="12" x2="21" y2="12"></line>
        <line x1="8" y1="18" x2="21" y2="18"></line>
        <line x1="3" y1="6" x2="3" y2="6"></line>
        <line x1="3" y1="12" x2="3" y2="12"></line>
        <line x1="3" y1="18" x2="3" y2="18"></line>
      </svg>
      Patches
    </button>
    <button id="hypo-settings" style="
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
    ">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09a1.65 1.65 0 0 0-1.51-1.65 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09a1.65 1.65 0 0 0 1.51-1.65 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
      Settings
    </button>
    <button id="hypo-reload" style="
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
    ">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10"></polyline>
        <polyline points="1 20 1 14 7 14"></polyline>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
      </svg>
      Reload
    </button>
  </div>
</div>

<!-- Template for patch items -->
<template id="hypo-patch-item-template">
  <div style="padding: var(--ha-space-m); background: var(--ha-surface); border-radius: var(--ha-radius-m); border: 1px solid var(--ha-border);">
    <label style="display: flex; align-items: center; gap: var(--ha-space-s);">
      <input type="checkbox" style="width: 16px; height: 16px;">
      <span style="color: var(--ha-text); font-weight: 500;"></span>
    </label>
    <small style="color: var(--ha-text-secondary); font-size: 11px; margin-top: var(--ha-space-xs); display: block;"></small>
  </div>
</template>
`;
    }
    show() {
      if (this.panel) return;
      this.panel = document.createElement("div");
      this.panel.id = "hypo-assistant-core";
      this.panel.innerHTML = this.getTemplate();
      document.body.appendChild(this.panel);
      this.patchItemTemplate = document.getElementById("hypo-patch-item-template");
      const toggleBtn = document.getElementById("hypo-toggle");
      const mainPanel = document.getElementById("hypo-panel");
      const collapseBtn = document.getElementById("hypo-collapse");
      const chat = document.getElementById("hypo-chat");
      const input = document.getElementById("hypo-input-field");
      const sendBtn = document.getElementById("hypo-send");
      const exportBtn = document.getElementById("hypo-export");
      const patchManagerBtn = document.getElementById("hypo-patch-manager");
      const settingsBtn = document.getElementById("hypo-settings");
      const reloadBtn = document.getElementById("hypo-reload");
      const addMessage = (text, role) => {
        const msg = document.createElement("div");
        msg.className = `msg ${role}`;
        msg.textContent = text;
        chat.appendChild(msg);
        chat.scrollTop = chat.scrollHeight;
      };
      const showPatchList = () => {
        const patches = this.storage.getPatches();
        chat.innerHTML = "";
        if (patches.length === 0) {
          const empty = document.createElement("p");
          empty.style.color = "#888";
          empty.textContent = "No patches yet.";
          chat.appendChild(empty);
        } else {
          patches.forEach((p) => {
            const frag = document.importNode(this.patchItemTemplate.content, true);
            const checkbox = frag.querySelector("input");
            const titleSpan = frag.querySelector("span");
            const dateEl = frag.querySelector("small");
            checkbox.dataset.id = p.id;
            checkbox.checked = p.enabled;
            titleSpan.textContent = p.title;
            titleSpan.title = p.id;
            dateEl.textContent = new Date(p.createdAt).toLocaleString();
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
            chat.appendChild(frag);
          });
        }
        const backBtn = document.createElement("button");
        backBtn.textContent = "\u2190 Back to chat";
        backBtn.style.cssText = `
                margin-top: 12px;
                padding: 6px 12px;
                background: #555;
                color: white;
                border: none;
                border-radius: 3px;
                cursor: pointer;
                font-size: 12px;
            `;
        backBtn.onclick = () => {
          chat.innerHTML = "";
          addMessage("\u{1F99B} Ready. Describe your change.", "assist");
        };
        chat.appendChild(backBtn);
      };
      toggleBtn.onclick = () => {
        toggleBtn.style.display = "none";
        mainPanel.style.display = "flex";
      };
      collapseBtn.onclick = () => {
        mainPanel.style.display = "none";
        toggleBtn.style.display = "flex";
      };
      patchManagerBtn.onclick = () => showPatchList();
      sendBtn.onclick = async () => {
        const query = input.value.trim();
        if (!query) return;
        input.value = "";
        addMessage(query, "user");
        this.abortController?.abort();
        this.abortController = new AbortController();
        const configRaw = localStorage.getItem("hypoAssistantConfig");
        const config = configRaw ? JSON.parse(configRaw) : {};
        const llmConfig = config.llm || {
          apiKey: config.apiKey,
          apiEndpoint: config.apiEndpoint,
          model: config.model
        };
        if (!llmConfig.apiKey) {
          addMessage("\u26A0\uFE0F Set API key in \u2699\uFE0F", "assist");
          return;
        }
        try {
          const result = await this.onUserRequest(query, this.abortController.signal);
          addMessage(result.groupTitle, "assist");
          if (confirm("Apply patch?")) {
            const existing = this.storage.getPatches();
            const updated = [...existing, ...result.patches];
            PatchManager.applyToolCalls(result.patches.map((p) => p.toolCall));
            this.storage.savePatches(updated);
            addMessage('\u2705 Applied. Enable in "\u{1F9E9} Patches" to persist.', "assist");
          }
        } catch (err) {
          if (err.name !== "AbortError") {
            addMessage(`\u274C ${err.message}`, "assist");
          }
        }
      };
      exportBtn.onclick = () => {
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
      };
      settingsBtn.onclick = () => {
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
        addMessage("\u2705 Config saved.", "assist");
        if (key && key !== llm.apiKey) {
          localStorage.removeItem("hypoAssistantSemanticIndex");
          addMessage("\u{1F504} Semantic index will be rebuilt on next request.", "assist");
        }
      };
      reloadBtn.onclick = () => location.reload();
      addMessage("\u{1F99B} Ready. Describe your change.", "assist");
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
      async (query, signal) => await engine.run(query, signal),
      storage
    );
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => ui.show());
    } else {
      ui.show();
    }
  })();
})();
