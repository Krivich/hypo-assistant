// ТЕЗИС: Патчинг — хирургическая операция: минимальное изменение, без innerHTML.
// ТЕЗИС: Инкрементальное обновление DOM предпочтительнее document.write, если возможно.

import type { Sources, Patch } from '../types';

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

export class PatchManager {
  static applyPatches(sources: Sources, patches: Patch[]): Sources {
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

  static injectPatchedSources(patched: Sources): void {
    const htmlSource = patched['HTML_DOC'];
    if (htmlSource) {
      document.open();
      document.write(htmlSource.content);
      document.close();
      return;
    }

    let scriptIndex = 0;
    document.querySelectorAll('script:not([src]):not([id="hypo-assistant-core"])').forEach(el => {
      const id = `inline-script-${scriptIndex++}`;
      const src = patched[id];
      if (src) el.textContent = src.content;
    });

    let styleIndex = 0;
    document.querySelectorAll('style').forEach(el => {
      const id = `inline-style-${styleIndex++}`;
      const src = patched[id];
      if (src) el.textContent = src.content;
    });

    let tmplIndex = 0;
    document.querySelectorAll('template').forEach(el => {
      const id = `template-${tmplIndex++}`;
      const src = patched[id];
      if (src) el.innerHTML = src.content;
    });
  }
}
