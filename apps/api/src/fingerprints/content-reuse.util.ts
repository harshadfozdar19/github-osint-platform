import { RepoAnalysisContext } from '../detection/rules/rule.types';
import {
  collectHaystacks,
  resolveEvidenceFile,
} from '../detection/rules/secrets.rule';
import { hashContent } from './code-fingerprint.util';

export interface ContentReuseMatch {
  kind: 'phrase' | 'file_hash';
  file?: string;
  lineNumber?: number;
  evidence: string;
  matchedText?: string;
}

const MAX_PHRASE_MATCHES = 10;
const MAX_FILE_HASH_MATCHES = 10;
/** Files smaller than this are skipped for hash comparison - a trivially small/empty file (e.g. `{}`) can hash-match by coincidence across totally unrelated repos, not because either copied the other. */
const MIN_FILE_HASH_BYTES = 200;

/**
 * Checks whether the brand's own distinctive content (see
 * distinctive-content.util.ts) appears verbatim anywhere in this repo's
 * text - the "did they copy our wording" counterpart to
 * findCredentialReuseMatches. Reuses the same haystacks
 * (description/readme/files) as the secret scanner so a phrase is only ever
 * compared against the same text a human reviewer would see cited as
 * evidence. Case-insensitive: a verbatim copy that only differs by casing
 * (e.g. re-templated into different markup) should still count.
 */
export function findPhraseReuseMatches(
  ctx: RepoAnalysisContext,
  knownPhrases: string[],
): ContentReuseMatch[] {
  if (knownPhrases.length === 0) return [];

  const results: ContentReuseMatch[] = [];
  const haystacks = collectHaystacks(ctx);
  let matchCount = 0;

  for (const phrase of knownPhrases) {
    if (matchCount >= MAX_PHRASE_MATCHES) break;
    const needle = phrase.toLowerCase();
    if (!needle) continue;

    for (const { source, text } of haystacks) {
      if (matchCount >= MAX_PHRASE_MATCHES) break;
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        results.push({
          kind: 'phrase',
          file: resolveEvidenceFile(source, ctx),
          lineNumber: i + 1,
          evidence: `Found in ${source} on line ${i + 1}: "${lines[i].trim().slice(0, 300)}" - matches the brand's own wording verbatim`,
          matchedText: phrase,
        });
        matchCount += 1;
        // Only the first occurrence of this phrase in this haystack counts -
        // a phrase repeated many times in one file (a template loop, say)
        // shouldn't be reported as if it were many independent matches.
        break;
      }
    }
  }

  return results;
}

/**
 * Checks whether any file in this repo is byte-for-byte identical to a file
 * in the brand's own reference repos - the "did they copy a whole file"
 * counterpart to findCredentialReuseMatches, using the same exact-content
 * hash already computed during reference ingestion (code-fingerprint.util.ts).
 * Not a similarity judgment - an exact hash match either happened or it
 * didn't, same category of evidence as a credential-hash match.
 */
export function findFileHashReuseMatches(
  ctx: RepoAnalysisContext,
  knownFileHashes: ReadonlySet<string>,
): ContentReuseMatch[] {
  if (knownFileHashes.size === 0) return [];

  const candidates: Array<{ path: string; content: string }> = [
    ...ctx.smallFileTexts,
  ];
  if (ctx.readmeText) {
    candidates.push({
      path: ctx.readmePath || 'README.md',
      content: ctx.readmeText,
    });
  }

  const results: ContentReuseMatch[] = [];
  for (const { path, content } of candidates) {
    if (results.length >= MAX_FILE_HASH_MATCHES) break;
    if (!content || Buffer.byteLength(content, 'utf8') < MIN_FILE_HASH_BYTES)
      continue;
    const hash = hashContent(content);
    if (!knownFileHashes.has(hash)) continue;
    results.push({
      kind: 'file_hash',
      file: path,
      evidence: `${path} is byte-for-byte identical to a file in the brand's own reference repository - not similar, an exact copy.`,
    });
  }
  return results;
}
