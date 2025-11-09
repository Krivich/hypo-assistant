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
