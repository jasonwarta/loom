/**
 * Secret scrubbing for context packages (ARCHITECTURE section 22). Context is
 * assembled from repo files and handed to a worker (and, if the worker is a
 * remote model, off the machine). Redact common secret shapes before it leaves
 * the platform. This is defense-in-depth, not a guarantee -- pair it with
 * least-privilege isolation and never putting real credentials in task specs.
 */

const REDACTED = "[REDACTED]";

interface Rule {
  readonly re: RegExp;
  readonly replace: string;
}

const RULES: Rule[] = [
  // PEM private key blocks.
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, replace: "[REDACTED PRIVATE KEY]" },
  // Provider API keys / tokens.
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replace: REDACTED }, // OpenAI / Anthropic style
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, replace: REDACTED }, // GitHub tokens
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: REDACTED }, // AWS access key id
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: REDACTED }, // Google API key
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: REDACTED }, // Slack
  { re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g, replace: "Bearer [REDACTED]" },
  // env-style assignment to a secret-ish key: keep the key, redact the value.
  {
    re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY)[A-Z0-9_]*)(\s*[=:]\s*)(['"]?)[^\s'"]{6,}\3/gi,
    replace: "$1$2$3[REDACTED]$3",
  },
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.re, rule.replace);
  return out;
}
