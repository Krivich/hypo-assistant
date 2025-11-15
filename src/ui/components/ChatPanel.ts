// src/ui/components/ChatPanel.ts
export class ChatPanel {
    constructor(private readonly element: HTMLElement) {}

    clear(): void {
        this.element.innerHTML = '';
    }

    addMessage(text: string, role: 'user' | 'assist'): void {
        const msg = document.createElement('div');
        msg.className = `msg ${role}`;
        msg.textContent = text;
        this.element.appendChild(msg);
        this.element.scrollTop = this.element.scrollHeight;
    }


    addMessageWidget(element: HTMLElement, role: 'user' | 'assist'): void {
        const msg = document.createElement('div');
        msg.className = `msg ${role}`;
        msg.appendChild(element);
        this.element.appendChild(msg);
    }

    getElement(): HTMLElement {
        return this.element;
    }
}