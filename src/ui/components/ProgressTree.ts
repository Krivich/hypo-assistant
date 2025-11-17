// src/ui/components/ProgressView.ts
import { Freezable } from '../../types.js';
import { ChatPanel } from './ChatPanel.js';

interface TreeNode {
    name: string;
    path: string[];
    startTime: number;
    duration: number | null;
    children: TreeNode[];
    parent: TreeNode | null;
}

export class ProgressView implements Freezable {
    private widget: HTMLElement;
    private treeLinesContainer: HTMLElement;
    private lineTemplate: HTMLTemplateElement;
    private activeNode: TreeNode | null = null;
    private activeRemainingMs = 0;
    private nodeMap = new Map<string, TreeNode>();
    private rootNodes: TreeNode[] = [];

    constructor(
        private chatPanel: ChatPanel,
        lineTemplate: HTMLTemplateElement,
        userQuery: string
    ) {
        const templateEl = document.getElementById('hypo-progress-widget-template');
        if (!(templateEl instanceof HTMLTemplateElement)) {
            throw new Error('Progress widget template not found');
        }

        const frag = document.importNode(templateEl.content, true);
        this.widget = frag.firstElementChild as HTMLElement;
        if (!this.widget) throw new Error('Progress widget root missing');

        // Обновляем заголовок, чтобы отразить запрос (опционально)
        const header = this.widget.querySelector('.ha-widget-header');
        if (header) {
            // Ограничиваем длину, чтобы не ломать UI
            const displayQuery = userQuery.length > 30 ? userQuery.slice(0, 30) + '…' : userQuery;
            header.textContent = `🕒 ${displayQuery}`;
        }

        this.treeLinesContainer = this.widget.querySelector('.progress-tree-lines')!;
        this.lineTemplate = lineTemplate;

        this.chatPanel.addMessageWidget(this.widget, 'assist');
    }

    private getKey(path: string[]): string {
        return path.join('\0');
    }

    private getOrCreateNode(path: string[], now: number): TreeNode {
        const key = this.getKey(path);
        if (this.nodeMap.has(key)) {
            return this.nodeMap.get(key)!;
        }

        const name = path[path.length - 1];
        const node: TreeNode = {
            name,
            path: [...path],
            startTime: now,
            duration: null,
            children: [],
            parent: null,
        };

        if (path.length === 1) {
            this.rootNodes.push(node);
        } else {
            const parentPath = path.slice(0, -1);
            const parent = this.getOrCreateNode(parentPath, now);
            node.parent = parent;
            parent.children.push(node);
        }

        this.nodeMap.set(key, node);
        return node;
    }

    public render(currentPath: string[], remainingMs: number): void {
        const now = Date.now();
        const currentKey = this.getKey(currentPath);

        if (this.activeNode && this.activeNode.path.join('\0') !== currentKey) {
            const isActiveAncestor =
                currentPath.length > this.activeNode.path.length &&
                currentPath
                    .slice(0, this.activeNode.path.length)
                    .every((seg, i) => seg === this.activeNode!.path[i]);

            if (!isActiveAncestor) {
                this.activeNode.duration = now - this.activeNode.startTime;
            }
        }

        const currentNode = this.getOrCreateNode(currentPath, now);
        this.activeNode = currentNode;
        this.activeRemainingMs = remainingMs;

        this.renderTree();
    }

    private renderTree(): void {
        this.clearAllTimers();
        this.treeLinesContainer.innerHTML = '';

        const renderNodes = (nodes: TreeNode[], depth: number) => {
            for (const node of nodes) {
                this.renderNode(node, depth);
                if (node.children.length > 0) {
                    renderNodes(node.children, depth + 1);
                }
            }
        };

        renderNodes(this.rootNodes, 0);
    }

    private renderNode(node: TreeNode, depth: number): void {
        const frag = document.importNode(this.lineTemplate.content, true);
        const line = frag.firstElementChild as HTMLElement;
        const skeleton = line.querySelector<HTMLElement>('.tree-skeleton')!;
        const textEl = line.querySelector<HTMLElement>('.action-text')!;
        const timerEl = line.querySelector<HTMLElement>('.action-timer')!;

        let prefix = '';
        if (depth > 0) {
            prefix = '   '.repeat(depth - 1) + '└─ ';
        }
        skeleton.textContent = prefix;
        textEl.textContent = node.name;

        if (node === this.activeNode) {
            this.startCountdown(timerEl, this.activeRemainingMs);
        } else if (node.duration !== null) {
            const sec = Math.ceil(node.duration / 1000);
            timerEl.textContent = `${sec}s`;
            timerEl.className = 'action-timer completed';
        } else {
            timerEl.textContent = '';
            timerEl.className = 'action-timer';
        }

        this.treeLinesContainer.appendChild(frag);
    }

    private startCountdown(timerEl: HTMLElement, msLeft: number): void {
        const tick = () => {
            if (msLeft <= 0) {
                timerEl.textContent = '✓';
                timerEl.className = 'action-timer completed';
                timerEl.removeAttribute('data-interval-id');
                return;
            }
            const totalSec = Math.ceil(msLeft / 1000);
            const h = Math.floor(totalSec / 3600);
            const m = Math.floor((totalSec % 3600) / 60);
            const s = totalSec % 60;
            const parts = [];
            if (h > 0) parts.push(String(h).padStart(2, '0'));
            parts.push(String(m).padStart(2, '0'));
            parts.push(String(s).padStart(2, '0'));
            timerEl.textContent = parts.join(':');
            msLeft -= 1000;
        };

        tick();
        const intervalId = setInterval(tick, 1000);
        timerEl.setAttribute('data-interval-id', String(intervalId));
    }

    private clearAllTimers(): void {
        const timers = this.widget.querySelectorAll('.action-timer[data-interval-id]');
        timers.forEach((el) => {
            const id = el.getAttribute('data-interval-id');
            if (id) {
                clearInterval(Number(id));
                el.removeAttribute('data-interval-id');
            }
        });
    }

    private _getLastNode(): TreeNode | null {
        let node: TreeNode | null = null;
        const findLast = (nodes: TreeNode[]) => {
            if (nodes.length === 0) return;
            const last = nodes[nodes.length - 1];
            node = last;
            if (last.children.length > 0) {
                findLast(last.children);
            }
        };
        findLast(this.rootNodes);
        return node;
    }

    // === Freezable ===
    freeze(): void {
        this.clearAllTimers();
        this.activeNode = null;
        if (this.rootNodes.length > 0) {
            const lastNode = this._getLastNode();
            if (lastNode && lastNode.duration === null) {
                lastNode.duration = Date.now() - lastNode.startTime;
            }
        }
        this.renderTree();

        // Визуальная фиксация
        this.widget.classList.add('frozen');
        const hint = this.widget.querySelector('.ha-hint');
        if (hint) hint.remove();
    }

    // Опционально: можно вызывать при полной очистке чата
    destroy(): void {
        this.clearAllTimers();
        this.widget.remove();
    }
}