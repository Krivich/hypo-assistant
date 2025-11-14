export class ExportHandler {
  export(): void {
    const clonedDoc = document.cloneNode(true) as Document;
    const script = clonedDoc.querySelector('script[src="./HypoAssistant.js"]');
    if (script) script.remove();
    clonedDoc.querySelectorAll('script:not([src]):not([id])').forEach(el => {
      if (el.textContent?.includes('hashLang')) el.remove();
    });
    const core = clonedDoc.getElementById('hypo-assistant-core');
    if (core) core.remove();

    const blob = new Blob([`<!DOCTYPE html>\n${clonedDoc.documentElement.outerHTML}`], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'patched-page.html';
    a.click();
    URL.revokeObjectURL(url);
  }
}
