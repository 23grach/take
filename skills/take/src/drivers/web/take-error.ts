export class TakeError extends Error {
  readonly step: number;
  constructor(step: number, message: string) {
    super(step < 0 ? `opening the app: ${message}` : `step ${step + 1}: ${message}`);
    this.step = step;
  }
}
