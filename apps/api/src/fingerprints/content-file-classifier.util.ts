/**
 * Identifies files in a repo likely to hold brand-distinctive human-readable
 * content (UI copy, legal text, docs) as opposed to generic source code or
 * config. Distinctive-phrase extraction is deliberately restricted to these
 * files rather than run over every file - a `package.json`/`tsconfig.json`/
 * arbitrary source line can superficially look "distinctive" by word count
 * alone, but isn't brand content. Known limitation: UI strings written
 * inline in component code (not pulled into a locale/template file) aren't
 * covered by this heuristic - only genuinely separated content files are.
 */

export type ContentFileCategory = 'locale' | 'template' | 'legal' | 'docs';

const LOCALE_DIR_RE = /(^|\/)(locales?|i18n|translations?|lang)\//i;
const LOCALE_EXT_RE = /\.(po|pot)$/i;
const LOCALE_FILENAME_RE =
  /^(en|en-us|en-gb|strings|messages|translations)\.json$/i;

const TEMPLATE_DIR_RE = /(^|\/)(templates?|emails?|email-templates?)\//i;
const TEMPLATE_EXT_RE = /\.(hbs|handlebars|ejs|mjml|liquid)$/i;

const LEGAL_FILENAME_RE =
  /^(terms|terms-of-service|tos|privacy|privacy-policy|eula)(\.[a-z0-9]+)?$/i;

const DOCS_FILENAME_RE = /^readme(\.[a-z0-9]+)?$/i;
const GENERIC_PROSE_EXT_RE = /\.(md|mdx|txt)$/i;

/** Boilerplate docs/legal-adjacent files that are near-universally identical across unrelated repos - never worth extracting bait from. */
const EXCLUDED_FILENAMES = new Set([
  'license',
  'license.md',
  'license.txt',
  'changelog',
  'changelog.md',
  'code_of_conduct.md',
  'contributing.md',
  'contributing',
  'notice',
  'notice.md',
]);

function basename(path: string): string {
  const lower = path.toLowerCase();
  return lower.split('/').pop() || lower;
}

export function classifyContentFile(path: string): ContentFileCategory | null {
  const lower = path.toLowerCase();
  const filename = basename(lower);

  if (EXCLUDED_FILENAMES.has(filename)) return null;

  if (
    LOCALE_DIR_RE.test(lower) ||
    LOCALE_EXT_RE.test(lower) ||
    LOCALE_FILENAME_RE.test(filename)
  ) {
    return 'locale';
  }
  if (TEMPLATE_DIR_RE.test(lower) || TEMPLATE_EXT_RE.test(lower)) {
    return 'template';
  }
  if (LEGAL_FILENAME_RE.test(filename)) {
    return 'legal';
  }
  if (DOCS_FILENAME_RE.test(filename) || GENERIC_PROSE_EXT_RE.test(lower)) {
    return 'docs';
  }
  return null;
}

export function isContentBearingFile(path: string): boolean {
  return classifyContentFile(path) !== null;
}
