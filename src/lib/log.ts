// Structured JSON logging. One event per line so Workers Logs / `wrangler tail`
// can filter and index them. Event names are dotted (run.start, llm.call, ...);
// carry a runId in pipeline logs and a reqId in request-error logs so a single
// operation can be traced across lines.
//
// Usage:
//   log("info", "run.finish", { runId, published: 3 });
//   log.error("http.error", { reqId, err: String(e) });

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

interface LogFn {
  (level: LogLevel, event: string, fields?: LogFields): void;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

function emit(level: LogLevel, event: string, fields?: LogFields): void {
  // Keep the line compact and always valid JSON. Errors go to console.error so
  // they surface distinctly in Workers Logs; everything else to console.log.
  let line: string;
  try {
    line = JSON.stringify({ level, event, ...fields });
  } catch {
    // Defensive: a non-serializable field must never break the caller.
    line = JSON.stringify({ level, event, note: "unserializable fields" });
  }
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = emit as LogFn;
log.debug = (event, fields) => emit("debug", event, fields);
log.info = (event, fields) => emit("info", event, fields);
log.warn = (event, fields) => emit("warn", event, fields);
log.error = (event, fields) => emit("error", event, fields);

// Normalize any thrown value to a short string for a log/alert field.
export function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
