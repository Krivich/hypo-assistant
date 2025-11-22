// ТЕЗИС: Сбор исходников — чистая функция с минимальными побочными эффектами (только fetch).
// ТЕЗИС: Внешние ресурсы (JS/CSS) собираются, но ошибки не прерывают процесс — только логируются.
// ТЕЗИС: Все ресурсы HypoAssistant помечаются data-hypo-ignore при инжекте и исключаются из индексации — они не являются частью целевого сайта.
import type { Sources } from '../types';

async function sha256(str: string): Promise<string> {
    const buf = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function collectOriginalSources(): Promise<Sources> {
    const sources: Sources = {};

    // === HTML_DOC: клонируем и удаляем все data-hypo-ignore ===
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-hypo-ignore]').forEach(el => el.remove());
    const htmlContent = clone.outerHTML;
    const htmlHash = await sha256(htmlContent);
    sources['HTML_DOC'] = {
        type: 'html',
        content: htmlContent,
        hash: htmlHash,
        signatureStart: '<!--==HTML_DOC==-->',
        signatureEnd: '<!--==/HTML_DOC==-->'
    };

    // === Inline scripts (без src) ===
    const inlineScripts = document.querySelectorAll('script:not([src])');
    let scriptIndex = 0;
    for (const el of inlineScripts) {
        if (el.closest('[data-hypo-ignore]')) continue;
        const content = el.textContent || '';
        const hash = await sha256(content);
        const id = `inline-script-${scriptIndex++}`;
        sources[id] = {
            type: 'js',
            content,
            hash,
            signatureStart: `/*==${id}==*/`,
            signatureEnd: `/*==/${id}==*/`
        };
    }

    // === Inline стили ===
    const inlineStyles = document.querySelectorAll('style');
    let styleIndex = 0;
    for (const el of inlineStyles) {
        if (el.closest('[data-hypo-ignore]')) continue;
        const content = el.textContent || '';
        const hash = await sha256(content);
        const id = `inline-style-${styleIndex++}`;
        sources[id] = {
            type: 'css',
            content,
            hash,
            signatureStart: `/*==${id}==*/`,
            signatureEnd: `/*==/${id}==*/`
        };
    }

    // === Template элементы ===
    const templates = document.querySelectorAll('template');
    let templateIndex = 0;
    for (const el of templates) {
        if (el.closest('[data-hypo-ignore]')) continue;
        const content = el.innerHTML;
        const hash = await sha256(content);
        const id = `template-${templateIndex++}`;
        sources[id] = {
            type: 'html',
            content,
            hash,
            signatureStart: `<!--==${id}==-->`,
            signatureEnd: `<!--==/${id}==-->`
        };
    }

    // === Внешние скрипты (script[src]) ===
    const scriptLinks = Array.from(document.querySelectorAll('script[src]'));
    for (let i = 0; i < scriptLinks.length; i++) {
        const script = scriptLinks[i] as HTMLScriptElement;
        // Внешние скрипты не содержат data-hypo-ignore, но можно пропустить, если их src указывает на наш бандл
        // (в текущей архитектуре это маловероятно — они загружаются отдельно)
        try {
            const resp = await fetch(script.src);
            const content = await resp.text();
            const hash = await sha256(content);
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

    // === Внешние CSS (link[rel="stylesheet"]) ===
    const links = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'));
    for (let i = 0; i < links.length; i++) {
        const link = links[i] as HTMLLinkElement;
        try {
            const resp = await fetch(link.href);
            const content = await resp.text();
            const hash = await sha256(content);
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

    return sources;
}