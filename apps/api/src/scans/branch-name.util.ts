/**
 * Deliberately conservative allowlist for a git ref used in
 * `git clone --branch <ref>` (see CloneScanService.cloneAndScan) - real
 * branch names are overwhelmingly plain alphanumerics/dots/dashes/
 * underscores/slashes, and this exists purely to keep a hostile branch name
 * (leading "-", which spawn's argv array can't turn into shell injection but
 * COULD still make git parse it as an option/flag instead of a ref name)
 * from ever reaching git. Rejects a leading "-" (option-injection defense)
 * and ".." (path-traversal-shaped refs).
 *
 * Lives in its own dependency-free file rather than on CloneScanService
 * itself - CloneScanService and ScanPipelineService already import from
 * each other (pathPriority/TEXT_FILE_RE one way, the CloneScanService class
 * itself the other), and routing the DTO-level validation (AnalyzeBranchDto)
 * through CloneScanService's own module shifted evaluation order enough to
 * turn that existing circular import into a real "Nest can't resolve
 * dependencies of ScanPipelineService" boot failure. A neutral, standalone
 * util both sides can import avoids adding a new edge to that cycle.
 */
export const SAFE_BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,250}$/;

export function assertSafeBranchName(branch: string): void {
  if (!SAFE_BRANCH_RE.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}
