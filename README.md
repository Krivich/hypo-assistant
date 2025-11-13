# 🦛 HypoAssistant — Live Site Editing, Right in Your Browser

> **Don’t wait for developers to fix what bothers you. Make it better — for yourself, right now.**  
> HypoAssistant is a local assistant that helps you modify any website **without access to source code**, without builds, and without reloads (when possible).

Perfect if you:
- get an idea while on the go and want to test it instantly,
- want to prototype a UX improvement on a live site,
- are tired of someone else’s interface limitations — and ready to take matters into your own hands.

🔹 **[Try the demo](https://Krivich.github.io/hypo-assistant/)**

---

## 💡 How It Works

1. **Analysis**  
   HypoAssistant reads the current page: HTML, styles, scripts — everything available in the DOM and linked resources.

2. **Request**  
   You describe what you’d like to change: _“Make the submit button green”_, _“Add highlight for important notifications”_.

3. **Patch**  
   Using the full context, it generates a **minimal, reversible patch** — not a rewrite, but a surgical edit.

4. **Apply**  
   You see exactly what will change and decide whether to apply it. Everything happens **locally, in your browser**.

---

## ✨ Why It’s Different from a Regular AI Chat

| Regular AI Chat | HypoAssistant |
|------------------|----------------|
| Sees only your prompt | Analyzes the **entire live page** |
| Gives general advice | Suggests a **working patch** |
| Requires manual copy-paste | Applies with **one click** |
| No guarantee it fits | Patch is grounded in **real structure** |

> ⚠️ AI can make mistakes — always review the suggested changes.

---

## 🧰 Core Capabilities

- **Zero-install, zero-server**: works directly from GitHub Pages.
- **RAG-powered context**: indexes HTML, inline/external JS, CSS, and `<template>` content.
- **Surgical DOM edits**: uses safe, reversible operations (`setTextContent`, `addStyleRule`, etc.).
- **Text-level fallback**: for script/template edits, applies semantic-aware text patches.
- **Patch management**: save, disable, or reapply changes via the built-in patch manager.
- **LLM-agnostic**: works with any OpenRouter-compatible model (or local LLM endpoint).
- **Offline-ready**: once loaded, no internet required for UI or patch application.

---

## 🔒 Privacy & Transparency

- **No server**: all logic runs in your browser.
- **No telemetry**: no analytics, no tracking, no external data collection.
- **Full visibility**: raw LLM requests and responses are logged to the console.
- **Token safety**: your API key never leaves your browser.

> ⚠️ When using a cloud-based LLM, the **full indexed page (HTML/JS/CSS)** is sent to the model provider. Do not use on confidential pages unless you trust the provider.

---

## 🛠️ Who Is It For?

- **Developers** who want to quickly prototype ideas on live sites.
- **Users** tired of inconvenient interfaces and ready to improve them.
- **Researchers** exploring:
    - **local RAG** (retrieval-augmented generation),
    - **dynamic tool calling** (structured DOM mutation instructions),
    - **adaptive chunking** with automatic handling of LLM context limits.

---

## 🧠 Design Principles

- **Minimalism**: code understandable in 5 minutes
- **DOM lives in HTML**: JS manages, never generates markup
- **Push-based orchestration**: updates flow in, no polling
- **Configurable by default**: flexibility without complexity
- **Strict TypeScript**: type-safe from the ground up
- **Safe tool calling**: all changes via declarative, idempotent operations
- **Automatic adaptive chunking**: system self-adjusts when context exceeds model limits

---

## 📜 License

MIT — free to use, study, and improve.

---

> **HypoAssistant isn’t a replacement for development — it’s a way to extend its reach into real-time, live-site experimentation.**  
> Built for those who believe: if you want something improved, the best way is often to do it yourself.