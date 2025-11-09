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

## 🧰 Flexibility and Control

- **Your choice of model**: free tier for quick experiments, premium models for critical tasks.
- **Transparent data flow**:
  We **have no server**, so your data never reaches us.
  However, if you use a cloud-based LLM, **the entire indexed code of the page** (HTML, JS, CSS) may be sent to the model provider.
  **Do not use HypoAssistant on pages with confidential information** unless you trust the provider.
  For full privacy, use local models.
- **Export your work**: save patches or export the full HTML for later use.
- **Easy to embed**: just add a `<script>` tag — no dependencies, no build step.

---

## 🛠️ Who Is It For?

- **Developers** who want to quickly prototype ideas on live sites.
- **Users** tired of inconvenient interfaces and ready to improve them.
- **Researchers** exploring local RAG and live editing capabilities.

---

## 🧠 Design Principles

- **Minimalism**: code understandable in 5 minutes
- **DOM lives in HTML**: JS manages, never generates markup
- **Push-based orchestration**: updates flow in, no polling
- **Configurable by default**: flexibility without complexity
- **Strict TypeScript**: type-safe from the ground up

---

## 📜 License

MIT — free to use, study, and improve.

---

> **HypoAssistant isn’t a replacement for development — it’s a way to extend its reach into real-time, live-site experimentation.**
> Built for those who believe: if you want something improved, the best way is often to do it yourself.
