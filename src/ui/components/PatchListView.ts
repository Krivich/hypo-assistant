import type { StoredPatch } from '../../types.js';
import { PatchManager } from '../../core/PatchManager.js';
import { StorageAdapter } from '../../config/StorageAdapter.js';
import { ChatPanel } from './ChatPanel.js';

export class PatchListView {
  constructor(
    private chatPanel: ChatPanel,
    private patchItemTemplate: HTMLTemplateElement,
    private storage: StorageAdapter,
    private onBack: () => void
  ) {}

  show(): void {
    const patches = this.storage.getPatches();
    this.chatPanel.clear();

    if (patches.length === 0) {
      const empty = document.createElement('p');
      empty.style.color = '#888';
      empty.textContent = 'No patches yet.';
      this.chatPanel.getElement().appendChild(empty);
    } else {
      patches.forEach(p => {
        const frag = document.importNode(this.patchItemTemplate.content, true);
        const checkbox = frag.querySelector('input')!;
        const titleSpan = frag.querySelector('span')!;
        const dateEl = frag.querySelector('small')!;

        checkbox.dataset.id = p.id;
        checkbox.checked = p.enabled;
        titleSpan.textContent = p.title;
        titleSpan.title = p.id;
        dateEl.textContent = new Date(p.createdAt).toLocaleString();

        checkbox.addEventListener('change', () => {
          const id = checkbox.dataset.id;
          if (!id) return;
          const current = this.storage.getPatches();
          const updated = current.map(pp => pp.id === id ? { ...pp, enabled: checkbox.checked } : pp);
          this.storage.savePatches(updated);
          if (checkbox.checked) {
            const patch = updated.find(pp => pp.id === id)!;
            PatchManager.applyToolCalls([patch.toolCall]);
          }
        });

        this.chatPanel.getElement().appendChild(frag);
      });
    }

    const backBtn = document.createElement('button');
    backBtn.textContent = '← Back to chat';
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
    backBtn.onclick = this.onBack;
    this.chatPanel.getElement().appendChild(backBtn);
  }
}
