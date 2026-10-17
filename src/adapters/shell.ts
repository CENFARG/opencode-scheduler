// Shell escaping helpers shared by POSIX adapters (systemd/cron/launchd).

/** Escape for POSIX double-quoted context (v1 escapeSystemdArg semantics). */
export function escapeShellArg(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** Escape for double-quoted shell string incl. $ and backtick (v1 cron entry). */
export function shellEscapeDoubleQuoted(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1")
}
