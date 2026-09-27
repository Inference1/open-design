const SHARE_VIEWER_URL_ENV = "OD_SHARE_VIEWER_URL";
const SHARE_VIEWER_URLS_ENV = "OD_SHARE_VIEWER_URLS";

type ShareViewerProfileMap = Readonly<Partial<Record<"prod" | "test" | "feature-test" | "local", string>>>;

/**
 * Share Viewer origins a packaged daemon receives by default, per release
 * channel and keyed by AMR profile. The origin belongs to the AMR backend
 * that stores the publication, so the stable default only names the prod
 * profile: a stable build launched against another profile gets no link
 * rather than a production link for a non-production publication.
 *
 * TODO(share decision 67 #10): beta, prerelease, preview, and every other
 * non-stable channel stay unset until the test/staging Viewer domain is
 * provided (the test environment is deferred). Unset means the daemon
 * reports every publication as "link unavailable" instead of guessing a host.
 *
 * The channel is the one `startPackagedSidecars` infers, which falls back to
 * stable when neither the app version nor the namespace names a channel (for
 * example local tools-pack builds and headless launches on the default
 * namespace). Those runs get the stable map too; that is safe because the map
 * only answers for the prod profile, whose publications do live behind the
 * production Viewer.
 */
export const PACKAGED_SHARE_VIEWER_URLS_BY_CHANNEL: Readonly<Record<string, ShareViewerProfileMap>> = {
  stable: { prod: "https://open-design.app" },
};

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Env the packaged launcher adds to the daemon spawn for the share Viewer
 * origin. An operator-provided `OD_SHARE_VIEWER_URL` or `OD_SHARE_VIEWER_URLS`
 * in the launch environment wins and is forwarded unchanged, with no channel
 * default mixed in. The launcher never validates: the daemon's resolver is the
 * single HTTPS-only, root-only gate.
 */
export function resolvePackagedShareViewerEnv(
  releaseChannel: string | null | undefined,
  launchEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const url = nonBlank(launchEnv[SHARE_VIEWER_URL_ENV]);
  const urls = nonBlank(launchEnv[SHARE_VIEWER_URLS_ENV]);
  if (url != null || urls != null) {
    return {
      ...(url == null ? {} : { [SHARE_VIEWER_URL_ENV]: url }),
      ...(urls == null ? {} : { [SHARE_VIEWER_URLS_ENV]: urls }),
    };
  }
  const defaults = releaseChannel == null
    ? undefined
    : Object.prototype.hasOwnProperty.call(PACKAGED_SHARE_VIEWER_URLS_BY_CHANNEL, releaseChannel)
      ? PACKAGED_SHARE_VIEWER_URLS_BY_CHANNEL[releaseChannel]
      : undefined;
  if (defaults == null || Object.keys(defaults).length === 0) return {};
  return { [SHARE_VIEWER_URLS_ENV]: JSON.stringify(defaults) };
}
