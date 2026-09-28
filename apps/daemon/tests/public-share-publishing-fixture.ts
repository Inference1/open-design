import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { createShareAliasReservations } from '../src/collab/share-alias-reservation.js';
import { createShareBindingOutbox } from '../src/collab/share-binding-outbox.js';
import { createSharePublicationCompletion } from '../src/collab/share-publication-completion.js';
import { createPublicFilePublicationRecorder } from '../src/collab/public-file-publication-recording.js';
import { resolvePublicShareLink } from '../src/collab/public-share-viewer-url.js';
import { parseProjectShareState } from '../src/collab/vela-project-share-state.js';
import type { PublicFilePublicationStore } from '../src/collab/public-file-publication-store.js';
import type { RegisterCollabSyncRoutesDeps } from '../src/routes/collab-sync.js';

export type FixtureShareCloud = Map<string, { projectId: string; sourceFilePath: string; slug: string; status: 'active' | 'stopped' }>;
export const fixtureShareSlug = 'a863b8d7-cc55-465a-a359-435bd3ef4919';
/** What the synthetic `vela share … --json` adds to an ACTIVE binding: AMR's
 * `url`, or `link: {status:'unavailable', code}` (AA5 shapes). Stopped
 * bindings carry neither, exactly like the real CLI. */
export type FixtureAmrShareFields = (projectId: string, slug: string) => Record<string, unknown>;
/** Real local publish pipeline. Only the CLI transport is synthetic. The Web
 * origin is explicit fixture configuration, never an ambient/prod fallback. */
export function createPublicSharePublishingFixture(
  db: Database.Database,
  store: PublicFilePublicationStore,
  resource: (args: string[], workspace: string) => Promise<string>,
  enqueue: Parameters<typeof createPublicFilePublicationRecorder>[2] = () => ({ enqueued: 0, skippedInbound: 0 }),
  options: { env?: NodeJS.ProcessEnv; configuredEnv?: Record<string, string>; amr?: FixtureAmrShareFields; failShareState?: () => boolean; pending?: boolean; failUpload?: boolean; failStop?: boolean; failResume?: boolean; commands?: string[][]; cloud?: FixtureShareCloud } = {},
): Pick<RegisterCollabSyncRoutesDeps, 'sharePublishing' | 'readProjectShareState' | 'resolvePublicShareLink'> {
  const outbox = createShareBindingOutbox(db);
  let ids = 0;
  const cloud: FixtureShareCloud = options.cloud ?? new Map();
  const viewerEnv = options.env ?? { OD_SHARE_VIEWER_URL: 'https://viewer.example.test' };
  const amrFields = (projectId: string, slug: string) => options.amr?.(projectId, slug) ?? {};
  // Publish and read share one resolver, as in server.ts.
  return { resolvePublicShareLink: (projectId, slug, amr) => resolvePublicShareLink(projectId, slug, amr, viewerEnv, options.configuredEnv), readProjectShareState: async scope => {
    if (options.failShareState?.()) throw new Error('SHARE_STATE_UNAVAILABLE');
    const publications = [...cloud.values()].filter(item => item.projectId === scope.projectId).map(({ projectId, ...item }) =>
      ({ ...item, ...(item.status === 'active' ? amrFields(projectId, item.slug) : {}) }));
    // The raw `vela share project-status --json` body, through the real parser.
    return parseProjectShareState(JSON.stringify({ projectId: scope.projectId, bindingExists: publications.length > 0, publications }), scope.projectId);
  }, sharePublishing: {
    reservations: createShareAliasReservations(db, () => ids++ === 0 ? fixtureShareSlug : randomUUID()),
    outbox,
    complete: createSharePublicationCompletion(db, createPublicFilePublicationRecorder(db, store, enqueue), outbox, true),
    prepare: async (scope, slug) => ({
      run: async args => {
        options.commands?.push([...args]);
        if (args[0] === 'resource') {
          if (options.failUpload) throw new Error('upload unavailable');
          return resource(args.slice(1), scope.resourceTeamId);
        }
        if (args[0] !== 'share') throw new Error('unexpected CLI namespace');
        if (args[1] === 'stop') {
          if (options.failStop) throw new Error('remote stop unavailable');
          cloud.set(scope.projectId + ':' + scope.filePath, { projectId: scope.projectId, sourceFilePath: scope.filePath, slug, status: 'stopped' });
          return JSON.stringify({ status: 'stopped', projectId: scope.projectId, slug });
        }
        if (args[1] === 'bind' || args[1] === 'resume') {
          if (args[1] === 'resume' && options.failResume) throw new Error('resume unavailable');
          if (args[1] === 'bind' && cloud.get(scope.projectId + ':' + scope.filePath)?.status === 'stopped') throw new Error('SHARE_BINDING_STOPPED');
          cloud.set(scope.projectId + ':' + scope.filePath, { projectId: scope.projectId, sourceFilePath: scope.filePath, slug, status: 'active' });
          return JSON.stringify({ status: 'active', projectId: scope.projectId, slug, ...amrFields(scope.projectId, slug),
            verifiedVersion: Number(args[args.indexOf('--version') + 1]), verifiedVersionId: args[args.indexOf('--version-id') + 1] });
        }
        if (args[1] !== 'publish') throw new Error('unexpected share operation');
        const versionId = args[args.indexOf('--version-id') + 1];
        const receipt = { slug, versionId, version: 1, publishedAt: 1, entryPath: args[args.indexOf('--entry-path') + 1] };
        const pending = options.pending || cloud.get(scope.projectId + ':' + scope.filePath)?.status === 'stopped';
        if (!pending) cloud.set(scope.projectId + ':' + scope.filePath, { projectId: scope.projectId, sourceFilePath: scope.filePath, slug, status: 'active' });
        return JSON.stringify({ status: pending ? 'binding_pending' : 'published', ...receipt, receipt, snapshot: { versionId },
          ...(pending ? { binding: { code: 'SHARE_BINDING_UNAVAILABLE' } } : amrFields(scope.projectId, slug)) });
      },
    }),
    retry: () => {},
  } };
}
