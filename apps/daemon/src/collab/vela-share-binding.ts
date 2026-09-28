import { runVelaCommand, velaWorkspaceCommandOptions } from '../integrations/vela-command.js';
import { parseAmrShareLink, type AmrShareLink } from './public-share-viewer-url.js';

export interface VelaShareBindingInput {
  /** Original project-relative path persisted in the publication receipt. */
  sourceFilePath: string;
  workspaceId: string;
  projectId: string;
  resourceId: string;
  slug: string;
  version: number;
  versionId: string;
}

/** Complete only the captured publication's binding. The Go command uses a
 * dedicated guarded endpoint; never fall back to registration or publication.
 * Callers can supply a runner pinned to the original verified session.
 */
export async function bindVelaShareVersion(input: VelaShareBindingInput, run: typeof runVelaCommand = runVelaCommand): Promise<AmrShareLink | null> {
  return completeVelaShareVersion('bind', input, run);
}

/** Only an explicit owner publish request may resume a stopped generation.
 * Background binding retries must continue using bindVelaShareVersion. */
export async function resumeVelaShareVersion(input: VelaShareBindingInput, run: typeof runVelaCommand = runVelaCommand): Promise<AmrShareLink | null> {
  return completeVelaShareVersion('resume', input, run);
}

/** Resolves with the address AMR reported for the now-active binding (null
 * when it reported none). A rejected address is unavailable, not a failure:
 * the binding itself was confirmed. */
async function completeVelaShareVersion(operation: 'bind' | 'resume', input: VelaShareBindingInput, run: typeof runVelaCommand): Promise<AmrShareLink | null> {
  try {
    const request = Object.freeze({ ...input });
    if ([request.sourceFilePath, request.workspaceId, request.projectId, request.resourceId, request.slug, request.versionId]
      .some(value => typeof value !== 'string' || !value.trim())
      || !Number.isSafeInteger(request.version) || request.version < 1) throw new Error('invalid binding identity');
    const stdout = await run(['share', operation, request.slug, '--project-id', request.projectId,
      '--source-file-path', request.sourceFilePath, '--resource-id', request.resourceId, '--version', String(request.version), '--version-id', request.versionId, '--json'],
    { ...velaWorkspaceCommandOptions(request.workspaceId), timeoutMs: 30_000 });
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid binding receipt');
    const record = value as Record<string, unknown>;
    if (record.status !== 'active' || record.projectId !== request.projectId || record.slug !== request.slug
      || record.verifiedVersion !== request.version || record.verifiedVersionId !== request.versionId) throw new Error('unverified binding');
    return parseAmrShareLink(record, request.projectId, request.slug);
  } catch {
    throw new Error('PUBLIC_SHARE_BINDING_FAILED');
  }
}
