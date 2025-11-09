// ТЕЗИС: Конфигурация всегда возвращает значение — даже если внешний файл отсутствует.
// ТЕЗИС: Дефолты задаются прямо в коде, а не в константах — это позволяет переопределять их в будущем без правки логики.

type ConfigValue = string | number | boolean | null | undefined;

export class AppConfig {
  private externalConfig: Record<string, unknown> | null = null;
  private readonly localStorageKey = 'hypoAssistantConfig';

  async init(): Promise<void> {
    try {
      const resp = await fetch('/app-config.json');
      if (resp.ok) {
        this.externalConfig = await resp.json();
      }
    } catch (e) {
      // silent — config is optional
    }
  }

  get<T extends ConfigValue>(defaultValue: T, path: string): T {
    const localStorageRaw = localStorage.getItem(this.localStorageKey);
    const localStorageConfig = localStorageRaw ? JSON.parse(localStorageRaw) : null;

    // Helper to safely get nested property
    const getNested = (obj: unknown, p: string): unknown => {
      if (!obj || typeof obj !== 'object') return undefined;
      const keys = p.split('.');
      let current: unknown = obj;
      for (const key of keys) {
        if (current == null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[key];
      }
      return current;
    };

    // Priority: localStorage → externalConfig → defaultValue
    const fromLocalStorage = localStorageConfig ? getNested(localStorageConfig, path) : undefined;
    if (fromLocalStorage !== undefined) return fromLocalStorage as T;

    const fromExternal = this.externalConfig ? getNested(this.externalConfig, path) : undefined;
    if (fromExternal !== undefined) return fromExternal as T;

    return defaultValue;
  }

  set(path: string, value: unknown): void {
    const raw = localStorage.getItem(this.localStorageKey);
    const config = raw ? JSON.parse(raw) : {};

    // Set nested property
    const keys = path.split('.');
    let current: Record<string, unknown> = config;
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]] = value;

    localStorage.setItem(this.localStorageKey, JSON.stringify(config));
  }
}
