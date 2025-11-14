export class ToggleButton {
  constructor(private readonly element: HTMLButtonElement) {}

  onClick(handler: () => void): void {
    this.element.addEventListener('click', handler);
  }

  hide(): void {
    this.element.style.display = 'none';
  }

  show(): void {
    this.element.style.display = 'flex';
  }
}
