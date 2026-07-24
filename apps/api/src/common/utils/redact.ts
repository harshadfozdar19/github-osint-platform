/**
 * Redacts secret-like values for safe storage, logging, and UI display.
 * Keeps short prefixes/suffixes so analysts can correlate without full disclosure.
 */
export function redactSecret(
  value: string,
  visiblePrefix = 4,
  visibleSuffix = 4,
): string {
  if (!value) return '[REDACTED]';
  const trimmed = value.trim();
  if (trimmed.length <= visiblePrefix + visibleSuffix + 3) {
    return `${trimmed.slice(0, 2)}…[REDACTED]`;
  }
  return `${trimmed.slice(0, visiblePrefix)}…[REDACTED]…${trimmed.slice(-visibleSuffix)}`;
}

export function redactSecretsInText(text: string): string {
  if (!text) return text;

  let result = text;

  const patterns: Array<{
    regex: RegExp;
    replacer: (match: string) => string;
  }> = [
    {
      regex: /AKIA[0-9A-Z]{16}/g,
      replacer: (m) => redactSecret(m, 4, 4),
    },
    {
      regex: /ghp_[A-Za-z0-9_]{20,}/g,
      replacer: (m) => redactSecret(m, 4, 4),
    },
    {
      regex: /github_pat_[A-Za-z0-9_]{20,}/g,
      replacer: (m) => redactSecret(m, 8, 4),
    },
    {
      regex: /mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi,
      replacer: (m) => {
        try {
          const url = new URL(
            m.replace(/^mongodb\+srv/, 'https').replace(/^mongodb/, 'https'),
          );
          if (url.password) url.password = '***';
          if (url.username)
            url.username = redactSecret(url.username, 2, 0).replace(
              '…[REDACTED]',
              '***',
            );
          return url
            .toString()
            .replace(
              /^https/,
              m.startsWith('mongodb+srv') ? 'mongodb+srv' : 'mongodb',
            );
        } catch {
          return 'mongodb://***:***@[REDACTED]';
        }
      },
    },
    {
      regex:
        /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g,
      replacer: () =>
        '-----BEGIN PRIVATE KEY-----\n…[REDACTED]…\n-----END PRIVATE KEY-----',
    },
    {
      regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
      replacer: (m) => redactSecret(m, 6, 4),
    },
    {
      regex: /AIza[0-9A-Za-z_-]{35}/g,
      replacer: (m) => redactSecret(m, 4, 4),
    },
    {
      regex: /sk_live_[A-Za-z0-9]{20,}/g,
      replacer: (m) => redactSecret(m, 4, 4),
    },
    {
      regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
      replacer: (m) => redactSecret(m, 4, 4),
    },
    {
      regex: /sk-ant-[A-Za-z0-9_-]{20,}/g,
      replacer: (m) => redactSecret(m, 6, 4),
    },
    {
      regex: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
      replacer: (m) => redactSecret(m, 4, 4),
    },
    {
      regex: /postgres(?:ql)?:\/\/[^\s"'<>]+/gi,
      replacer: () => 'postgres://***:***@[REDACTED]',
    },
    {
      regex: /mysql:\/\/[^\s"'<>]+/gi,
      replacer: () => 'mysql://***:***@[REDACTED]',
    },
    {
      regex:
        /(?:api[_-]?key|token|secret|password)\s*[:=]\s*['"]?[^\s'"]{8,}['"]?/gi,
      replacer: (m) => {
        const parts = m.split(/[:=]/);
        if (parts.length < 2) return '[REDACTED]';
        return `${parts[0]}=${redactSecret(parts.slice(1).join('=').trim())}`;
      },
    },
  ];
  for (const { regex, replacer } of patterns) {
    result = result.replace(regex, replacer);
  }

  return result;
}
