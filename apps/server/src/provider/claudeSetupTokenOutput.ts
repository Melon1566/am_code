/**
 * Reads what `claude setup-token` prints in a pseudo-terminal. The CLI shows
 * an OAuth URL, waits for a pasted code, then prints a long-lived token.
 * Output arrives in arbitrary chunks with terminal escapes, so callers keep
 * an accumulated, stripped buffer and re-scan it.
 *
 * @module provider/claudeSetupTokenOutput
 */

// eslint-disable-next-line no-control-regex -- terminal escapes are control characters by definition
const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\r/g;
const AUTHORIZATION_URL_PATTERN =
  /https:\/\/(?:platform\.claude\.com|claude\.ai|console\.anthropic\.com)\/oauth\/authorize[^\s"'<>]*/;
const TOKEN_PREFIX = "sk-ant-oat01-";
const TOKEN_BODY_PATTERN = /^[A-Za-z0-9_-]+/;
const MIN_TOKEN_BODY_LENGTH = 20;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function findClaudeAuthorizationUrl(output: string): string | undefined {
  return AUTHORIZATION_URL_PATTERN.exec(output)?.[0];
}

/**
 * The token is only trusted once a delimiter follows it, or once the process
 * has exited (`final`), so a chunk boundary in the middle of the token does
 * not yield a truncated value.
 */
export function findClaudeSetupToken(
  output: string,
  options: { readonly final?: boolean } = {},
): string | undefined {
  let searchFrom = 0;
  while (searchFrom < output.length) {
    const start = output.indexOf(TOKEN_PREFIX, searchFrom);
    if (start === -1) return undefined;
    const bodyStart = start + TOKEN_PREFIX.length;
    const body = TOKEN_BODY_PATTERN.exec(output.slice(bodyStart))?.[0] ?? "";
    const end = bodyStart + body.length;
    const terminated = end < output.length || options.final === true;
    if (body.length >= MIN_TOKEN_BODY_LENGTH && terminated) {
      return `${TOKEN_PREFIX}${body}`;
    }
    if (!terminated) return undefined;
    searchFrom = end;
  }
  return undefined;
}
