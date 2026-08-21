import { DeepIntentContext, IntentContext } from './intent-provider.interface';
import { ParsedIntentPayload } from './parse-intent-result';

/**
 * Every string a model is allowed to cite in factors[].evidenceReferences -
 * built directly from what was actually supplied in this call's context, so
 * a citation that doesn't correspond to anything here is provably
 * fabricated, not just unfamiliar phrasing.
 */
function collectValidReferences(
  context: IntentContext,
  deepContext?: DeepIntentContext,
): string[] {
  const refs: string[] = [
    'repository',
    context.repository.fullName,
    context.repository.owner,
  ];
  for (const d of context.detections) {
    refs.push(d.ruleId, d.category);
  }
  if (context.brand) {
    refs.push('brand', context.brand.name);
    if (context.brand.matchType) refs.push(context.brand.matchType);
    if (context.brand.matchLocation) refs.push(context.brand.matchLocation);
    if (context.brand.matchedAlias) refs.push(context.brand.matchedAlias);
  }
  if (context.deployment) {
    refs.push('deployment', context.deployment.url, context.deployment.state);
    if (context.deployment.confirmedLive)
      refs.push('confirmedLive', 'confirmed-live-deployment');
  }
  refs.push('finding', context.finding.severity, ...context.finding.categories);
  refs.push(
    'operatorSignals',
    'otherBrandsHit',
    'linkedIdentityOwners',
    'contributors',
    'trustSignals',
  );
  for (const c of context.credentials) {
    refs.push(c.type, c.verificationStatus);
  }
  if (context.trustSignals.isTrustedOwner)
    refs.push('isTrustedOwner', 'trustedOwner');
  if (deepContext) {
    refs.push('readme');
    if (deepContext.readme?.path) refs.push(deepContext.readme.path);
    if (deepContext.rootPaths) refs.push(...deepContext.rootPaths);
    if (deepContext.manifest) refs.push(deepContext.manifest.path);
    for (const f of deepContext.flaggedFiles) refs.push(f.path);
  }
  return refs.filter(Boolean).map((r) => r.toLowerCase());
}

/**
 * Strips any evidenceReferences that don't correspond to anything actually
 * supplied in this call's context, and downgrades confidence when it does -
 * a citation the model can't ground in real evidence is either a
 * hallucination or, at best, vague enough not to trust as-is. Never
 * silently keeps an unsupported citation.
 */
export function validateCitations(
  result: ParsedIntentPayload,
  context: IntentContext,
  deepContext?: DeepIntentContext,
): { result: ParsedIntentPayload; strippedCount: number } {
  const validRefs = collectValidReferences(context, deepContext);
  let strippedCount = 0;

  const factors = result.factors.map((factor) => {
    const kept = factor.evidenceReferences.filter((ref) => {
      const needle = ref.toLowerCase();
      const supported = validRefs.some(
        (valid) => valid.includes(needle) || needle.includes(valid),
      );
      if (!supported) strippedCount += 1;
      return supported;
    });
    return { ...factor, evidenceReferences: kept };
  });

  if (strippedCount === 0) {
    return { result: { ...result, factors }, strippedCount };
  }

  return {
    result: {
      ...result,
      factors,
      // Unsupported citations mean the model's grounding wasn't fully
      // reliable this call - reflect that rather than silently accepting
      // the confidence it self-reported.
      confidence: Math.round(result.confidence * 0.7 * 100) / 100,
    },
    strippedCount,
  };
}
