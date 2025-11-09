// ТЕЗИС: Патчинг — хирургическая операция: минимальное изменение, без innerHTML.
// ТЕЗИС: Инкрементальное обновление DOM предпочтительнее document.write, если возможно.

import type { Sources, ToolCall } from '../types';

function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
}

export class PatchManager {
    // ТЕЗИС: Все изменения применяются через безопасные DOM-операции, fallback на текстовый патч — только в крайнем случае.
    static applyToolCalls(toolCalls: ToolCall[]): void {
        for (const call of toolCalls) {
            try {
                if (call.tool === 'setTextContent') {
                    const el = document.querySelector(call.selector);
                    if (el) el.textContent = call.text;
                }
                else if (call.tool === 'setAttribute') {
                    const el = document.querySelector(call.selector);
                    if (el) el.setAttribute(call.name, call.value);
                }
                else if (call.tool === 'insertAdjacentHTML') {
                    const el = document.querySelector(call.selector);
                    if (el) el.insertAdjacentHTML(call.position, call.html);
                }
                else if (call.tool === 'addStyleRule') {
                    const style = document.createElement('style');
                    style.textContent = `${call.selector} { ${call.style} }`;
                    document.head.appendChild(style);
                }
                else if (call.tool === 'removeElement') {
                    const el = document.querySelector(call.selector);
                    if (el) el.remove();
                }
                else if (call.tool === 'wrapElement') {
                    const el = document.querySelector(call.selector);
                    if (el && el.parentNode) {
                        const wrapper = document.createElement(call.wrapperTag);
                        if (call.wrapperClass) wrapper.className = call.wrapperClass;
                        el.parentNode.replaceChild(wrapper, el);
                        wrapper.appendChild(el);
                    }
                }
                else if (call.tool === 'applyTextPatch') {
                    // Fallback: only for cases where DOM tools are insufficient
                    const originalsRaw = localStorage.getItem('hypoAssistantOriginals');
                    if (!originalsRaw) continue;
                    const originals = JSON.parse(originalsRaw);
                    const patched = this.applyTextPatch(originals, call);
                    const htmlSource = patched['HTML_DOC'];
                    if (htmlSource) {
                        document.open();
                        document.write(htmlSource.content);
                        document.close();
                    }
                }
            } catch (e) {
                console.error('Failed to apply tool:', call, e);
            }
        }
    }

    // ТЕЗИС: applyTextPatch — внутренний fallback, не экспонируется напрямую.
    private static applyTextPatch(sources: Sources, patch: { file: string; from: string; to: string }): Sources {
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
}