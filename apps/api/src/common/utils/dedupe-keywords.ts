/**
 * Collapses keywords that only differ by case or surrounding whitespace
 * ("zerodha" vs "Zerodha ") into a single entry - matching against repo
 * content is already case-insensitive everywhere these are used, so treating
 * case variants as distinct keywords only produces duplicate search queries
 * and duplicate "found" evidence for what is, to a human, obviously the same
 * word. Keeps the first occurrence's original casing/order for the rest of
 * the pipeline to use.
 */
export function dedupeKeywordsCaseInsensitive(keywords: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of keywords) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}
