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
  const htmlContent = document.documentElement.outerHTML;
  const htmlHash = await sha256(htmlContent);
  sources['HTML_DOC'] = {
    type: 'html',
    content: htmlContent,
    hash: htmlHash,
    signatureStart: '<!--==HTML_DOC==-->',
    signatureEnd: '<!--==/HTML_DOC==-->'
  };

  document.querySelectorAll('script:not([src]):not([id="hypo-assistant-core"])').forEach((el, i) => {
    const id = `inline-script-${i}`;
    const content = el.textContent || '';
    const hash = sha256(content);
    sources[id] = {
      type: 'js',
      content,
      hash,
      signatureStart: `/*==${id}==*/`,
      signatureEnd: `/*==/${id}==*/`
    };
  });

  const scriptLinks = Array.from(document.querySelectorAll('script[src]'));
  for (let i = 0; i < scriptLinks.length; i++) {
    const script = scriptLinks[i];
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

  document.querySelectorAll('style').forEach((el, i) => {
    const id = `inline-style-${i}`;
    const content = el.textContent || '';
    const hash = sha256(content);
    sources[id] = {
      type: 'css',
      content,
      hash,
      signatureStart: `/*==${id}==*/`,
      signatureEnd: `/*==/${id}==*/`
    };
  });

  document.querySelectorAll('template').forEach((el, i) => {
    const id = `template-${i}`;
    const content = el.innerHTML;
    const hash = sha256(content);
    sources[id] = {
      type: 'html',
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
