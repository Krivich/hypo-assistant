// src/utils/AdaptiveProgressObserver.ts

export type ProgressUpdate = {
    path: string[];
    remainingMs: number;
};

export type FlowConfig = {
    steps: number;
    stepTimeMs?: number;
};

/**
 * Наблюдатель прогресса с иерархической агрегацией.
 * Каждый экземпляр отслеживает только свои шаги.
 * При создании дочернего флоу через `startFlow`,
 * его обновления автоматически агрегируются с текущим действием
 * и оставшимся временем, и передаются дальше через общий коллбэк.
 */
export class AdaptiveProgressObserver {
    private readonly _onProgress: ((update: ProgressUpdate) => void) | null;
    private readonly _totalSteps: number;
    private readonly _stepTimeMs: number;
    private _currentStepIndex: number = 0;
    private _currentStepRemainingMs: number | undefined = undefined;
    private _currentAction: string = '';

    constructor(
        onProgress: ((update: ProgressUpdate) => void) | null,
        config?: FlowConfig
    ) {
        this._onProgress = onProgress;
        this._totalSteps = config?.steps ?? 1;
        this._stepTimeMs = config?.stepTimeMs ?? 60_000;
    }

    /**
     * Создаёт дочерний поток прогресса.
     * Все обновления от дочернего флоу будут автоматически
     * агрегированы с текущим действием и оставшимся временем.
     */
    startFlow(config: FlowConfig): AdaptiveProgressObserver {
        const wrappedOnProgress = (childUpdate: ProgressUpdate) => {
            if (!this._onProgress) return;
            // Объединяем текущее действие с путём дочернего
            const fullPath = [this._currentAction, ...childUpdate.path];
            const myRemaining = this._computeRemainingMs();
            const totalRemaining = myRemaining + childUpdate.remainingMs;
            this._onProgress({ path: fullPath, remainingMs: totalRemaining });
        };
        return new AdaptiveProgressObserver(wrappedOnProgress, config);
    }

    /**
     * Начинает новый шаг на этом уровне.
     * @param action Краткое название шага
     * @param remainingMs Опциональная явная оценка оставшегося времени для этого шага
     */
    startStep(action: string): void;
    startStep(action: string, remainingMs: number): void;
    startStep(action: string, remainingMs?: number): void {
        this._currentAction = action;
        this._currentStepIndex++;
        this._currentStepRemainingMs = remainingMs !== undefined ? Math.max(0, remainingMs) : undefined;
        this._notify();
    }

    /**
     * Обновляет оценку оставшегося времени для текущего шага.
     */
    updateEstimate(remainingMs: number): void {
        if (this._currentStepIndex === 0) return;
        this._currentStepRemainingMs = Math.max(0, remainingMs);
        this._notify();
    }

    private _computeRemainingMs(): number {
        const currentEstimate = this._currentStepRemainingMs ?? this._stepTimeMs;
        const remainingSteps = Math.max(0, this._totalSteps - this._currentStepIndex);
        return currentEstimate + remainingSteps * this._stepTimeMs;
    }

    private _notify(): void {
        if (!this._onProgress) return;
        this._onProgress({
            path: [this._currentAction],
            remainingMs: this._computeRemainingMs()
        });
    }
}