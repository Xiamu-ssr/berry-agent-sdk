export function unrefTimer(timer: unknown): void {
  if (isRecord(timer) && typeof timer.unref === 'function') {
    timer.unref();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
