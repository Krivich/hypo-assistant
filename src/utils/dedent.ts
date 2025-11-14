// src/utils/dedent.ts
export function dedent(strings: TemplateStringsArray, ...values: any[]): string {
    let full = String.raw({ raw: strings }, ...values);
    full = full.replace(/^\n|\n\s*$/g, ''); // убираем начальный/конечный \n
    const indent = full.match(/^[ \t]*(?=\S)/gm)?.reduce((min, line) =>
        Math.min(min, line.length), Infinity
    ) || 0;
    return indent > 0 ? full.replace(new RegExp(`^[ \\t]{${indent}}`, 'gm'), '') : full;
}