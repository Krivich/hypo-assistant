// ТЕЗИС: Общие типы выносятся сюда ТОЛЬКО если используются в трёх и более модулях.
// ТЕЗИС: Избегаем "типовых помоек" — каждый тип должен иметь чёткую зону ответственности.

export interface Patch {
    file: string;
    from: string;
    to: string;
}

export interface SourceEntry {
    type: 'html' | 'js' | 'css';
    content: string;
    hash: string;
    signatureStart: string;
    signatureEnd: string;
}

export type Sources = Record<string, SourceEntry>;

export interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

// ТЕЗИС: ToolCall — безопасный, декларативный способ описания изменений DOM.
// ТЕЗИС: Все инструменты избегают выполнения JavaScript и не нарушают идемпотентность.
export type ToolCall =
    | { tool: 'setTextContent'; selector: string; text: string }
    | { tool: 'setAttribute'; selector: string; name: string; value: string }
    | { tool: 'insertAdjacentHTML'; selector: string; position: 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend'; html: string }
    | { tool: 'addStyleRule'; selector: string; style: string }
    | { tool: 'removeElement'; selector: string }
    | { tool: 'wrapElement'; selector: string; wrapperTag: string; wrapperClass?: string }
    | { tool: 'applyTextPatch'; file: string; from: string; to: string };

// ТЕЗИС: Патч — атомарное, обратимое изменение с уникальным ID и заголовком.
export interface StoredPatch {
    id: string;
    toolCall: ToolCall;
    dependsOn: string[];
    enabled: boolean;
    createdAt: string;
    title: string; // ≤ 60 символов
}

// Группа патчей: один пользовательский запрос
export interface PatchGroup {
    requestId: string;     // UUID группы
    userQuery: string;    // исходный запрос
    groupTitle: string;   // общий заголовок группы (≤ 80 символов)
    patches: StoredPatch[];
}

export interface PatchResult {
    message: string;
    patches: StoredPatch[];
    groupTitle: string; // для UI
}

export interface Freezable {
    freeze(): void;
}