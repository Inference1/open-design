import { buildSharePath } from '@open-design/contracts';
import { resolveEffectiveShareViewerOrigin } from '../integrations/share-viewer-origin.js';

type EnvMap = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** A dot-segment project id would be collapsed by URL resolution
 * (`/artifact/../<slug>` becomes `/<slug>`), so it is never a valid identity. */
function assertShareIdentity(projectId: string, slug: string): void {
  const trimmedProjectId = projectId.trim();
  if (!trimmedProjectId || trimmedProjectId === '.' || trimmedProjectId === '..' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(slug)) {
    throw new Error('PUBLIC_SHARE_IDENTITY_INVALID');
  }
}

/**
 * Resolve the canonical public Viewer address. Only presentation configuration
 * failures become null; invalid identity and publishing/authorization errors
 * remain errors. The address uses a root-shell origin, never the console URL.
 */
export function resolvePublicShareViewerUrl(
  projectId: string,
  slug: string,
  env: EnvMap = process.env,
  configuredEnv: EnvMap = {},
): string | null {
  assertShareIdentity(projectId, slug);
  try {
    return publicShareViewerUrl(projectId, slug, env, configuredEnv);
  } catch (error) {
    if (error instanceof Error && error.message === 'PUBLIC_SHARE_WEB_URL_UNAVAILABLE') return null;
    throw error;
  }
}

/** Strict variant used by callers that must distinguish unavailable links. */
export function publicShareViewerUrl(
  projectId: string,
  slug: string,
  env: EnvMap = process.env,
  configuredEnv: EnvMap = {},
): string {
  assertShareIdentity(projectId, slug);
  const origin = resolveEffectiveShareViewerOrigin(env, configuredEnv);
  if (!origin) throw new Error('PUBLIC_SHARE_WEB_URL_UNAVAILABLE');
  return new URL(buildSharePath({ projectId, slug }), origin).href;
}
