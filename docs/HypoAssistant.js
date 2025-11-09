"use strict";
var HypoAssistant = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // src/core/PatchManager.ts
  var PatchManager_exports = {};
  __export(PatchManager_exports, {
    PatchManager: () => PatchManager
  });
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }
  var PatchManager;
  var init_PatchManager = __esm({
    "src/core/PatchManager.ts"() {
      "use strict";
      PatchManager = class {
        static applyPatches(sources, patches) {
          const patched = deepClone(sources);
          for (const patch of patches) {
            const file = patched[patch.file];
            if (!file) continue;
            const fullFrom = file.signatureStart + patch.from + file.signatureEnd;
            const fullTo = file.signatureStart + patch.to + file.signatureEnd;
            if (file.content.includes(fullFrom)) {
              file.content = file.content.replace(fullFrom, fullTo);
            }
          }
          return patched;
        }
        static injectPatchedSources(patched) {
          const htmlSource = patched["HTML_DOC"];
          if (htmlSource) {
            document.open();
            document.write(htmlSource.content);
            document.close();
            return;
          }
          let scriptIndex = 0;
          document.querySelectorAll('script:not([src]):not([id="hypo-assistant-core"])').forEach((el) => {
            const id = `inline-script-${scriptIndex++}`;
            const src = patched[id];
            if (src) el.textContent = src.content;
          });
          let styleIndex = 0;
          document.querySelectorAll("style").forEach((el) => {
            const id = `inline-style-${styleIndex++}`;
            const src = patched[id];
            if (src) el.textContent = src.content;
          });
          let tmplIndex = 0;
          document.querySelectorAll("template").forEach((el) => {
            const id = `template-${tmplIndex++}`;
            const src = patched[id];
            if (src) el.innerHTML = src.content;
          });
        }
      };
    }
  });

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
      const model = this.config.get("qwen/qwen3-coder:free", "llm.model");
      const timeoutMs = this.config.get(6e4, "llm.timeouts.generationMs");
      const maxRetries = this.config.get(3, "llm.maxRetries");
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
        const combinedSignal = AbortSignal.any([signal, controller.signal]);
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
      const id = `inline-script-${i}`;
      const content = el.textContent || "";
      const hash = sha256(content);
      sources[id] = {
        type: "js",
        content,
        hash,
        signatureStart: `/*==${id}==*/`,
        signatureEnd: `/*==/${id}==*/`
      };
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
      const id = `inline-style-${i}`;
      const content = el.textContent || "";
      const hash = sha256(content);
      sources[id] = {
        type: "css",
        content,
        hash,
        signatureStart: `/*==${id}==*/`,
        signatureEnd: `/*==/${id}==*/`
      };
    });
    document.querySelectorAll("template").forEach((el, i) => {
      const id = `template-${i}`;
      const content = el.innerHTML;
      const hash = sha256(content);
      sources[id] = {
        type: "html",
        content,
        hash,
        signatureStart: `<!--==${id}==-->`,
        signatureEnd: `<!--==/${id}==-->`
      };
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
    return sources;
  }

  // src/core/SemanticIndexer.ts
  function isFallbackIndex(entry) {
    return entry.purpose === "One-sentence role" || entry.purpose === "Unindexed html file" || entry.key_entities.length === 0 || entry.key_entities.length === 3 && entry.key_entities.every((k) => ["functions", "classes", "CSS classes"].includes(k));
  }
  var SemanticIndexer = class {
    constructor(config, storage, llm) {
      this.config = config;
      this.storage = storage;
      this.llm = llm;
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
        if (!stored || stored.hash !== meta.hash || isFallbackIndex(stored)) {
          try {
            const systemPrompt = {
              role: "system",
              content: `You are a precise code analyst. Analyze the following ${meta.type} file and return ONLY a JSON object with:
{
  "purpose": "Exactly one sentence. What this file does in the app?",
  "key_entities": [
    "List every important CSS class (e.g. '.chat-messages', '.send-btn'), function name, variable, or event listener.",
    "Do NOT use generic terms like 'CSS classes' or 'functions'. Be specific."
  ],
  "dependencies": [
    "List file IDs (e.g. 'inline-script-3', 'linked-css-1') that this file likely interacts with.",
    "If unsure, leave empty array."
  ]
}
Rules:
- Be exhaustive in key_entities.
- Never summarize or generalize.
- If the file is empty or trivial, set purpose to "Trivial or empty file".
- Return ONLY valid JSON. No markdown, no explanation.`
            };
            const userPrompt = {
              role: "user",
              content: `[FILE: ${fileId}]
${meta.content}`
            };
            const summary = await this.llm.call([systemPrompt, userPrompt], `indexing:${fileId}`);
            semanticIndex[fileId] = { ...summary, hash: meta.hash };
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
      const relevancePrompt = {
        role: "system",
        content: `Project structure:
${JSON.stringify(semanticIndex, null, 2)}
Return {"relevant": ["file_id"]}`
      };
      const relevanceRes = await this.llm.call([relevancePrompt, { role: "user", content: userQuery }], "relevance", signal);
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
        content: `Generate a minimal, safe patch that fulfills the user request.
Return a JSON object with:
{
  "file": "file_id",
  "from": "exact substring to replace",
  "to": "replacement content"
}
Rules:
- NEVER use innerHTML.
- The "from" string must appear exactly in the provided file.
- Be minimal and surgical.
- Return ONLY valid JSON. No markdown, no explanation.`
      };
      const userMsg = { role: "user", content: `Context:
${contextBlocks}

User request: ${userQuery}` };
      const patchRes = await this.llm.call([patchPrompt, userMsg], "patch", signal);
      const finalPatch = {
        file: patchRes.file || relevantIds[0],
        from: patchRes.from,
        to: patchRes.to
      };
      console.log("\u{1F3C6} Final patch:", finalPatch);
      const diagnostics = this.storage.getDiagnostics();
      diagnostics.runs.push({
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        phase: "final_patch",
        data: finalPatch
      });
      this.storage.saveDiagnostics(diagnostics);
      console.groupEnd();
      return {
        message: "Patch generated via direct LLM request.",
        patches: [finalPatch]
      };
    }
  };

  // src/ui/UI.ts
  var HypoAssistantUI = class {
    constructor(onUserRequest) {
      this.onUserRequest = onUserRequest;
    }
    panel = null;
    abortController = null;
    getTemplate() {
      return `
      <style>
        #hypo-panel { position: fixed; right: 0; top: 0; width: 360px; height: 100vh;
          background: #1e1e1e; color: #e0e0e0; font-family: monospace; z-index: 10000;
          box-shadow: -2px 0 10px rgba(0,0,0,0.5); display: flex; flex-direction: column; }
        #hypo-header { padding: 10px; background: #2d2d2d; font-weight: bold; }
        #hypo-chat { flex: 1; overflow-y: auto; padding: 10px; font-size: 13px; }
        .msg { margin: 8px 0; white-space: pre-wrap; }
        .user { color: #4caf50; }
        .assist { color: #2196f3; }
        #hypo-input { display: flex; padding: 10px; background: #252526; }
        #hypo-input input { flex: 1; background: #333; color: white; border: none; padding: 8px; border-radius: 3px; }
        #hypo-input button { background: #007acc; color: white; border: none; padding: 8px 12px; margin-left: 8px; border-radius: 3px; cursor: pointer; }
        #hypo-actions { padding: 10px; display: flex; gap: 6px; }
        #hypo-actions button { flex: 1; padding: 6px; background: #3a3a3a; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
      </style>
      <div id="hypo-panel">
        <div id="hypo-header">\u{1F99B} HypoAssistant v1.1</div>
        <div id="hypo-chat"></div>
        <div id="hypo-input">
          <input type="text" placeholder="Describe change..." id="hypo-input-field">
          <button id="hypo-send">Send</button>
        </div>
        <div id="hypo-actions">
          <button id="hypo-export">Export HTML</button>
          <button id="hypo-settings">\u2699\uFE0F Settings</button>
          <button id="hypo-reload">\u{1F504} Reload</button>
        </div>
      </div>
    `;
    }
    show() {
      if (this.panel) return;
      this.panel = document.createElement("div");
      this.panel.id = "hypo-assistant-core";
      this.panel.innerHTML = this.getTemplate();
      document.body.appendChild(this.panel);
      const chat = document.getElementById("hypo-chat");
      const input = document.getElementById("hypo-input-field");
      const send = document.getElementById("hypo-send");
      const exportBtn = document.getElementById("hypo-export");
      const settings = document.getElementById("hypo-settings");
      const reload = document.getElementById("hypo-reload");
      const addMsg = (text, cls) => {
        const el = document.createElement("div");
        el.className = `msg ${cls}`;
        el.textContent = text;
        chat.appendChild(el);
        chat.scrollTop = chat.scrollHeight;
      };
      send.onclick = async () => {
        const query = input.value.trim();
        if (!query) return;
        input.value = "";
        addMsg(query, "user");
        this.abortController?.abort();
        this.abortController = new AbortController();
        const configKey = "hypoAssistantConfig";
        const configRaw = localStorage.getItem(configKey);
        const config = configRaw ? JSON.parse(configRaw) : {};
        if (!config.apiKey) {
          addMsg("\u26A0\uFE0F Set API key in \u2699\uFE0F", "assist");
          return;
        }
        try {
          const res = await this.onUserRequest(query, this.abortController.signal);
          addMsg(res.message, "assist");
          if (confirm("Apply patch?")) {
            const patches = JSON.parse(localStorage.getItem("hypoAssistantPatches") || "[]");
            localStorage.setItem("hypoAssistantPatches", JSON.stringify([...patches, ...res.patches]));
            const originalsRaw = localStorage.getItem("hypoAssistantOriginals");
            if (originalsRaw) {
              const originals = JSON.parse(originalsRaw);
              const patched = (await Promise.resolve().then(() => (init_PatchManager(), PatchManager_exports))).PatchManager.applyPatches(originals, [...patches, ...res.patches]);
              (await Promise.resolve().then(() => (init_PatchManager(), PatchManager_exports))).PatchManager.injectPatchedSources(patched);
              addMsg("\u2705 Applied. Page reloaded.", "assist");
            }
          }
        } catch (err) {
          if (err.name !== "AbortError") {
            addMsg(`\u274C ${err.message}`, "assist");
          }
        }
      };
      exportBtn.onclick = () => {
        const blob = new Blob([document.documentElement.outerHTML], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "hypo-patched-app.html";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      };
      reload.onclick = () => location.reload();
      settings.onclick = () => {
        const currentConfigRaw = localStorage.getItem("hypoAssistantConfig");
        const currentConfig = currentConfigRaw ? JSON.parse(currentConfigRaw) : {};
        const ep = prompt("API Endpoint:", currentConfig.apiEndpoint || "https://openrouter.ai/api/v1/chat/completions") || currentConfig.apiEndpoint;
        const key = prompt("API Key:") || currentConfig.apiKey;
        const model = prompt("Model:", currentConfig.model || "qwen/qwen3-coder:free") || currentConfig.model;
        const newConfig = { ...currentConfig, apiEndpoint: ep, apiKey: key, model };
        localStorage.setItem("hypoAssistantConfig", JSON.stringify(newConfig));
        addMsg("\u2705 Config saved.", "assist");
        if (key && key !== currentConfig.apiKey) {
          localStorage.removeItem("hypoAssistantSemanticIndex");
          addMsg("\u{1F504} Semantic index will be rebuilt on next request.", "assist");
        }
      };
    }
  };

  // src/main.ts
  (async () => {
    "use strict";
    const config = new AppConfig();
    await config.init();
    const storage = new StorageAdapter();
    const llm = new LLMClient(config, storage);
    const engine = new HypoAssistantEngine(config, storage, llm);
    const ui = new HypoAssistantUI(async (query, signal) => {
      return await engine.run(query, signal);
    });
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => ui.show());
    } else {
      ui.show();
    }
  })();
})();
