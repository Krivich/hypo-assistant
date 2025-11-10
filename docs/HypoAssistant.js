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
        `[LLM Usage] ${context} \u2192 ${modelKey}: ${prompt_tokens}\u2191 + ${completion_tokens}\u2193 = ${usage.total_tokens} tokens; today: ${d.prompt}\u2191 + ${d.completion}\u2193 (${d.requests} reqs)`
      );
      console.log("\u27A1\uFE0F Request:", messages);
      console.log("\u2B05\uFE0F Response:", rawContent);
      console.groupEnd();
    }
    async call(messages, context, signal) {
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
          const response = await fetch(urlToUse, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model,
              messages,
              temperature: 0.1,
              response_format: { type: "json_object" }
            }),
            signal: combinedSignal
          });
          clearTimeout(timeoutId);
          if (!response.ok) {
            const errText = await response.text().catch(() => "unknown");
            throw new Error(`HTTP ${response.status}: ${errText}`);
          }
          const data = await response.json();
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
<!-- Floating toggle button -->
<div id="hypo-toggle" style="
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 56px;
  height: 56px;
  background: #6c63ff;
  color: white;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 10000;
  box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  font-size: 24px;
">\u{1F99B}</div>

<!-- Main panel -->
<div id="hypo-panel" style="
  display: none;
  position: fixed;
  right: 0;
  top: 0;
  width: 100vw;
  height: 100dvh;
  min-height: 100dvh;
  max-width: 360px;
  background: #1e1e1e;
  color: #e0e0e0;
  font-family: monospace;
  z-index: 10000;
  box-shadow: -2px 0 10px rgba(0,0,0,0.5);
  flex-direction: column;
">
  <div style="padding: 10px; background: #2d2d2d; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;">
    <div style="font-weight: bold;">\u{1F99B} HypoAssistant v1.1</div>
    <button id="hypo-collapse" style="
      background: #555;
      color: white;
      border: none;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 14px;
    ">\u2715</button>
  </div>
  <div id="hypo-chat" style="
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    font-size: 13px;
    min-height: 0;
  "></div>
  <div style="display: flex; padding: 10px; background: #252526; flex-shrink: 0;">
    <input type="text" placeholder="Describe change..." id="hypo-input-field" style="flex: 1; background: #333; color: white; border: none; padding: 8px; border-radius: 3px;">
    <button id="hypo-send" style="background: #007acc; color: white; border: none; padding: 8px 12px; margin-left: 8px; border-radius: 3px; cursor: pointer;">Send</button>
  </div>
  <div style="padding: 10px; display: flex; gap: 6px; flex-shrink: 0;">
    <button id="hypo-export" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">\u{1F4E4} Export</button>
    <button id="hypo-patch-manager" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">\u{1F9E9} Patches</button>
    <button id="hypo-settings" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">\u2699\uFE0F Settings</button>
    <button id="hypo-reload" style="flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px;">\u{1F504} Reload</button>
  </div>
</div>

<!-- Hidden template for patch items -->
<template id="hypo-patch-item-template">
  <div style="margin:8px 0; padding:8px; background:#3a3a3a; border-radius:4px;">
    <label style="display:flex; align-items:center; gap:8px;">
      <input type="checkbox">
      <span style="color:white;"></span>
    </label>
    <small style="color:#888; font-size:11px;"></small>
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
