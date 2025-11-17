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

    // ✅ Обновлённый метод: виджет СТАНОВИТСЯ сообщением
    addMessageWidget(widget: HTMLElement, role: 'user' | 'assist'): void {
        // Копируем классы, чтобы не потерять ha-widget и другие
        const classes = Array.from(widget.classList);
        // Добавляем классы сообщения
        widget.className = `msg ${role} ${classes.join(' ')}`;
        this.element.appendChild(widget);
        this.element.scrollTop = this.element.scrollHeight;
    }

    getElement(): HTMLElement {
        return this.element;
    }
}