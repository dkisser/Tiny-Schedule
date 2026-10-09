/**
 * Minimal structured logger for the AI slice.
 *
 * Replaces the pino `Logger` the Electron main process injected. The webview
 * has no log file to write to and no terminal attached, so the surface is
 * deliberately tiny — just the two levels the AI code actually calls — and the
 * default sink is `console`, which is visible in the webview inspector and in
 * `tauri dev`'s terminal.
 *
 * The payload is a flat `Record<string, unknown>` rather than pino's dot-path
 * style: it keeps call sites readable and avoids a structured-logging
 * dependency for six lines of code.
 */
export interface AiLogger {
  info(payload: Record<string, unknown>, message?: string): void;
  warn(payload: Record<string, unknown>, message?: string): void;
  error(payload: Record<string, unknown>, message?: string): void;
}

export const consoleLogger: AiLogger = {
  info: (payload, message) => console.info(message ?? '', payload),
  warn: (payload, message) => console.warn(message ?? '', payload),
  error: (payload, message) => console.error(message ?? '', payload),
};

/** A logger that swallows everything. Useful in tests. */
export const silentLogger: AiLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
