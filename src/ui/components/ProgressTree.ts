// ProgressTree.ts

interface TreeNode {
    name: string;
    path: string[];
    startTime: number;
    duration: number | null;
    children: TreeNode[];
    parent: TreeNode | null;
}

export class ProgressTree {
    private container: HTMLElement;
    private treeLinesContainer: HTMLElement; // ← контейнер только для строк дерева
    private readonly lineTemplate: HTMLTemplateElement;
    private readonly headerTemplate: HTMLTemplateElement | null = null;
    private rootNodes: TreeNode[] = [];
    private nodeMap = new Map<string, TreeNode>();
    private activeNode: TreeNode | null = null;
    private activeRemainingMs: number = 0;

    constructor(
        parent: HTMLElement,
        lineTemplate: HTMLTemplateElement,
        headerTemplate: HTMLTemplateElement | null = null,
        userQuery?: string
    ) {
        this.container = document.createElement('div');
        this.container.className = 'progress-tree';

        // Добавляем заголовок, если указан
        if (userQuery && headerTemplate) {
            const frag = document.importNode(headerTemplate.content, true);
            const headerEl = frag.firstElementChild as HTMLElement;
            // Убираем <strong> — делаем текст обычным
            headerEl.textContent = userQuery;
            this.container.appendChild(headerEl);
        }

        // Создаём отдельный контейнер для строк дерева
        this.treeLinesContainer = document.createElement('div');
        this.treeLinesContainer.className = 'progress-tree-lines';
        this.container.appendChild(this.treeLinesContainer);

        parent.appendChild(this.container);
        this.lineTemplate = lineTemplate;
        this.headerTemplate = headerTemplate;
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

    render(currentPath: string[], remainingMs: number): void {
        const now = Date.now();
        const currentKey = this.getKey(currentPath);

        // Завершаем предыдущий активный узел, если он не является предком текущего
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
        // Очищаем ТОЛЬКО контейнер строк, не трогая заголовок
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

        // Генерация псевдографики с правильными отступами
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

        // Добавляем в контейнер строк, а не в общий контейнер
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
        const timers = this.container.querySelectorAll('.action-timer[data-interval-id]');
        timers.forEach((el) => {
            const id = el.getAttribute('data-interval-id');
            if (id) {
                clearInterval(Number(id));
                el.removeAttribute('data-interval-id');
            }
        });
    }

    public freeze(): void {
        this.clearAllTimers();
        this.activeNode = null;
        if (this.rootNodes.length > 0) {
            const lastNode = this._getLastNode();
            if (lastNode && lastNode.duration === null) {
                lastNode.duration = Date.now() - lastNode.startTime;
            }
        }
        this.renderTree();
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

    clear(): void {
        this.clearAllTimers();
        this.rootNodes = [];
        this.nodeMap.clear();
        this.activeNode = null;
        this.treeLinesContainer.innerHTML = ''; // только строки
    }

    destroy(): void {
        this.clear();
        this.container.remove();
    }

    getElement(): HTMLElement {
        return this.container;
    }
}