import { resolveAmrProfile } from './vela-profile.js';

type EnvMap = NodeJS.ProcessEnv | Record<string, string | undefined>;
type ShareViewerProfile = 'prod' | 'test' | 'feature-test' | 'local';

const KNOWN_PROFILES = new Set<ShareViewerProfile>(['prod', 'test', 'feature-test', 'local']);

function parseViewerMap(raw: string | undefined): { valid: true; values: Record<string, unknown> } | { valid: false } | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { valid: false };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { valid: false };
  const values = parsed as Record<string, unknown>;
  if (Object.keys(values).some(key => !KNOWN_PROFILES.has(key as ShareViewerProfile))) return { valid: false };
  return { valid: true, values };
}

function normalizedShareViewerOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const candidate = value.trim();
  if (/[?#]/u.test(candidate) || candidate.slice(0, 8).toLowerCase() !== 'https://' || candidate.includes('\\')) return undefined;
  const authorityAndPath = candidate.slice(8);
  const firstPathSeparator = authorityAndPath.indexOf('/');
  const authority = firstPathSeparator >= 0 ? authorityAndPath.slice(0, firstPathSeparator) : authorityAndPath;
  if (authority.includes('@') || (firstPathSeparator >= 0 && authorityAndPath.slice(firstPathSeparator) !== '/')) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    return undefined;
  }
  return url.origin;
}

/**
 * Resolve a root-only HTTPS shell origin for the current AMR profile.
 * Profile-map structure and keys are validated as a whole, but only the
 * selected profile's value is validated. A present invalid selected value is
 * authoritative and cannot fall through to the single-origin setting.
 */
export function resolveEffectiveShareViewerOrigin(
  env: EnvMap = process.env,
  configuredEnv: EnvMap = {},
): string | undefined {
  const launchProfile = resolveAmrProfile(env);
  const selectedProfile = resolveAmrProfile({ ...env, ...configuredEnv });
  const profileMap = parseViewerMap(env.OD_SHARE_VIEWER_URLS);
  if (profileMap && !profileMap.valid) return undefined;
  if (profileMap?.valid && Object.prototype.hasOwnProperty.call(profileMap.values, selectedProfile)) {
    return normalizedShareViewerOrigin(profileMap.values[selectedProfile]);
  }
  if (selectedProfile !== launchProfile) return undefined;
  return normalizedShareViewerOrigin(env.OD_SHARE_VIEWER_URL);
}
