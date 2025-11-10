// ТЕЗИС: Сбор исходников — чистая функция с минимальными побочными эффектами (только fetch).
// ТЕЗИС: Внешние ресурсы (JS/CSS) собираются, но ошибки не прерывают процесс — только логируются.

import type { Sources, SourceEntry } from '../types';

async function sha256(str: string): Promise<string> {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function collectOriginalSources(): Promise<Sources> {
    const sources: Sources = {};

    // === HTML_DOC: хэш от всего outerHTML (корректно) ===
    const htmlContent = document.documentElement.outerHTML;
    const htmlHash = await sha256(htmlContent);
    sources['HTML_DOC'] = {
        type: 'html',
        content: htmlContent,
        hash: htmlHash,
        signatureStart: '<!--==HTML_DOC==-->',
        signatureEnd: '<!--==/HTML_DOC==-->'
    };

    // === Inline scripts (без src) ===
    document.querySelectorAll('script:not([src]):not([id="hypo-assistant-core"])').forEach((el, i) => {
        const content = el.textContent || '';
        // Хэш ТОЛЬКО от содержимого скрипта
        sha256(content).then(hash => {
            const id = `inline-script-${i}`;
            sources[id] = {
                type: 'js',
                content,
                hash,
                signatureStart: `/*==${id}==*/`,
                signatureEnd: `/*==/${id}==*/`
            };
        });
    });

    // === Внешние скрипты (fetch) ===
    const scriptLinks = Array.from(document.querySelectorAll('script[src]'));
    for (let i = 0; i < scriptLinks.length; i++) {
        const script = scriptLinks[i];
        try {
            const resp = await fetch(script.src);
            const content = await resp.text();
            const hash = await sha256(content); // ← только от содержимого файла
            const id = `external-script-${i}`;
            sources[id] = {
                type: 'js',
                content,
                hash,
                signatureStart: `/*==${id}==*/`,
                signatureEnd: `/*==/${id}==*/`
            };
        } catch (e) {
            console.warn('Failed to fetch JS:', script.src);
        }
    }

    // === Inline стили ===
    document.querySelectorAll('style').forEach((el, i) => {
        const content = el.textContent || '';
        // Хэш ТОЛЬКО от CSS-кода
        sha256(content).then(hash => {
            const id = `inline-style-${i}`;
            sources[id] = {
                type: 'css',
                content,
                hash,
                signatureStart: `/*==${id}==*/`,
                signatureEnd: `/*==/${id}==*/`
            };
        });
    });

    // === Template элементы ===
    document.querySelectorAll('template').forEach((el, i) => {
        const content = el.innerHTML;
        sha256(content).then(hash => {
            const id = `template-${i}`;
            sources[id] = {
                type: 'html',
                content,
                hash,
                signatureStart: `<!--==${id}==-->`,
                signatureEnd: `<!--==/${id}==-->`
            };
        });
    });

    // === Внешние CSS (link[rel="stylesheet"]) ===
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'));
    for (let i = 0; i < links.length; i++) {
        const link = links[i];
        try {
            const resp = await fetch(link.href);
            const content = await resp.text();
            const hash = await sha256(content); // ← только от содержимого CSS
            const id = `linked-css-${i}`;
            sources[id] = {
                type: 'css',
                content,
                hash,
                signatureStart: `/*==${id}==*/`,
                signatureEnd: `/*==/${id}==*/`
            };
        } catch (e) {
            console.warn('Failed to fetch CSS:', link.href);
        }
    }

    // ⚠️ Важно: все async-хэширования завершены синхронно?
    // Чтобы избежать race condition — перепишем без forEach + async

    // === Рефакторинг: Соберём всё синхронно ===
    const syncSources: Sources = {};

    // HTML_DOC
    syncSources['HTML_DOC'] = {
        type: 'html',
        content: htmlContent,
        hash: htmlHash,
        signatureStart: '<!--==HTML_DOC==-->',
        signatureEnd: '<!--==/HTML_DOC==-->'
    };

    // Inline scripts
    const inlineScripts = document.querySelectorAll('script:not([src]):not([id="hypo-assistant-core"])');
    for (let i = 0; i < inlineScripts.length; i++) {
        const el = inlineScripts[i];
        const content = el.textContent || '';
        const hash = await sha256(content);
        const id = `inline-script-${i}`;
        syncSources[id] = {
            type: 'js',
            content,
            hash,
            signatureStart: `/*==${id}==*/`,
            signatureEnd: `/*==/${id}==*/`
        };
    }

    // Inline styles
    const inlineStyles = document.querySelectorAll('style');
    for (let i = 0; i < inlineStyles.length; i++) {
        const el = inlineStyles[i];
        const content = el.textContent || '';
        const hash = await sha256(content);
        const id = `inline-style-${i}`;
        syncSources[id] = {
            type: 'css',
            content,
            hash,
            signatureStart: `/*==${id}==*/`,
            signatureEnd: `/*==/${id}==*/`
        };
    }

    // Templates
    const templates = document.querySelectorAll('template');
    for (let i = 0; i < templates.length; i++) {
        const el = templates[i];
        const content = el.innerHTML;
        const hash = await sha256(content);
        const id = `template-${i}`;
        syncSources[id] = {
            type: 'html',
            content,
            hash,
            signatureStart: `<!--==${id}==-->`,
            signatureEnd: `<!--==/${id}==-->`
        };
    }

    // Внешние скрипты и CSS — уже обработаны выше с await

    return syncSources;
}