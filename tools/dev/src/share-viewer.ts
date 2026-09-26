/**
 * Default share Viewer origin that tools-dev hands the daemon it launches.
 *
 * BLOCKED on decision 67 #7: the test-environment HTTPS Viewer domain has not
 * been provided yet. Until it is, this stays empty and a locally launched
 * daemon reports every publication as "link temporarily unavailable" instead
 * of guessing a host. When the domain lands, set it here as an HTTPS root
 * origin (no path, query, fragment, or credentials). The daemon's resolver
 * enforces those rules and rejects anything else, including HTTP/localhost.
 */
export const TOOLS_DEV_DEFAULT_SHARE_VIEWER_URL = "";

const SHARE_VIEWER_URL_ENV = "OD_SHARE_VIEWER_URL";
const SHARE_VIEWER_URLS_ENV = "OD_SHARE_VIEWER_URLS";

/**
 * Env tools-dev adds to the daemon spawn for the share Viewer origin.
 * An operator-provided `OD_SHARE_VIEWER_URL` or `OD_SHARE_VIEWER_URLS` always
 * wins: the daemon inherits it unchanged and no default is injected.
 */
export function resolveToolsDevShareViewerEnv(
  env: NodeJS.ProcessEnv = process.env,
  defaultUrl: string = TOOLS_DEV_DEFAULT_SHARE_VIEWER_URL,
): Record<string, string> {
  const configured = env[SHARE_VIEWER_URL_ENV]?.trim() || env[SHARE_VIEWER_URLS_ENV]?.trim();
  if (configured) return {};
  const fallback = defaultUrl.trim();
  return fallback ? { [SHARE_VIEWER_URL_ENV]: fallback } : {};
}
