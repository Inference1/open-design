import { describe, expect, it } from 'vitest';

import { resolvePackagedShareViewerEnv } from '../src/share-viewer.js';
import { buildPackagedDaemonSpawnEnv } from '../src/sidecars.js';
import type { PackagedNamespacePaths } from '../src/paths.js';

function fakePaths(): PackagedNamespacePaths {
  return {
    cacheRoot: '/tmp/od-pkg/cache',
    dataRoot: '/tmp/od-pkg/data',
    desktopLogPath: '/tmp/od-pkg/logs/desktop/latest.log',
    desktopLogsRoot: '/tmp/od-pkg/logs/desktop',
    electronSessionDataRoot: '/tmp/od-pkg/user-data/session',
    electronUserDataRoot: '/tmp/od-pkg/user-data',
    installationRoot: '/tmp/od-pkg/..',
    installerObservationRoot: '/tmp/od-pkg/data/observations/installer',
    logsRoot: '/tmp/od-pkg/logs',
    namespaceRoot: '/tmp/od-pkg',
    resourceRoot: '/tmp/od-pkg/resources',
    runtimeRoot: '/tmp/od-pkg/runtime',
    updateRoot: '/tmp/od-pkg/updates',
  };
}

function spawnEnv(releaseChannel: string | null, shareViewerLaunchEnv: NodeJS.ProcessEnv = {}) {
  return buildPackagedDaemonSpawnEnv(fakePaths(), {
    appVersion: null,
    daemonCliEntry: null,
    requireDesktopAuth: false,
    releaseChannel,
    shareViewerLaunchEnv,
  });
}

describe('packaged share Viewer origin propagation', () => {
  it('hands a stable daemon the production Viewer origin for the prod AMR profile only', () => {
    const env = spawnEnv('stable');
    expect(JSON.parse(env.OD_SHARE_VIEWER_URLS ?? 'null')).toEqual({ prod: 'https://open-design.app' });
    expect(env.OD_SHARE_VIEWER_URL).toBeUndefined();
  });

  it.each(['beta', 'prerelease', 'preview', 'nightly'])(
    'leaves the %s daemon without a Viewer origin so shares report link unavailable',
    (channel) => {
      const env = spawnEnv(channel);
      expect(env).not.toHaveProperty('OD_SHARE_VIEWER_URL');
      expect(env).not.toHaveProperty('OD_SHARE_VIEWER_URLS');
    },
  );

  it('sets nothing when the release channel is unknown', () => {
    const env = spawnEnv(null);
    expect(env).not.toHaveProperty('OD_SHARE_VIEWER_URL');
    expect(env).not.toHaveProperty('OD_SHARE_VIEWER_URLS');
  });

  it('lets an explicit launch OD_SHARE_VIEWER_URL win over the channel default', () => {
    const env = spawnEnv('stable', { OD_SHARE_VIEWER_URL: ' https://viewer.example.test ' });
    expect(env.OD_SHARE_VIEWER_URL).toBe('https://viewer.example.test');
    expect(env).not.toHaveProperty('OD_SHARE_VIEWER_URLS');
  });

  it('lets an explicit launch OD_SHARE_VIEWER_URLS map win over the channel default', () => {
    const map = JSON.stringify({ test: 'https://viewer.example.test' });
    const env = spawnEnv('beta', { OD_SHARE_VIEWER_URLS: map });
    expect(env.OD_SHARE_VIEWER_URLS).toBe(map);
    expect(env).not.toHaveProperty('OD_SHARE_VIEWER_URL');
  });

  it('forwards launch values verbatim and leaves validation to the daemon resolver', () => {
    // The launcher only forwards: an HTTP value is passed through so the
    // daemon's single HTTPS-only resolver rejects it, instead of the launcher
    // silently swapping in the channel default.
    const env = spawnEnv('stable', { OD_SHARE_VIEWER_URL: 'http://viewer.example.test' });
    expect(env.OD_SHARE_VIEWER_URL).toBe('http://viewer.example.test');
    expect(env).not.toHaveProperty('OD_SHARE_VIEWER_URLS');
  });

  it('forwards both launch values unchanged when both are set', () => {
    const map = JSON.stringify({ prod: 'https://map.example.test' });
    const env = spawnEnv('stable', { OD_SHARE_VIEWER_URL: 'https://single.example.test', OD_SHARE_VIEWER_URLS: map });
    expect(env.OD_SHARE_VIEWER_URL).toBe('https://single.example.test');
    expect(env.OD_SHARE_VIEWER_URLS).toBe(map);
  });

  it('treats blank launch values as unset', () => {
    expect(resolvePackagedShareViewerEnv('stable', { OD_SHARE_VIEWER_URL: '  ', OD_SHARE_VIEWER_URLS: '' }))
      .toEqual({ OD_SHARE_VIEWER_URLS: JSON.stringify({ prod: 'https://open-design.app' }) });
  });
});
