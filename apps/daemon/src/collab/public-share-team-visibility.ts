import type Database from 'better-sqlite3';
import { ensureTeamProjectCommentConversations, getWorkspaceProjectByProjectId, rebindWorkspaceProject } from '../db.js';
import { projectResourceIdFor } from '../integrations/vela-team-projects.js';
import type { ResourceHubPrincipal } from './resource-principal.js';

/**
 * Decision 67 #11: publishing a public link for a private project in a TEAM
 * workspace registers that project in the team catalog, so it is team-visible
 * from that moment. Record that locally right after registration instead of
 * waiting for the background catalog reconcile.
 *
 * Until the local row says `team`, the project is neither Team-relayable (the
 * row is personal) nor personal-relayable (the workspace is a team), so the
 * publish backfill and every comment written in that window would be refused
 * or cancelled for good.
 *
 * Writes the same row state the reconciler's owner `bind` would, and only for
 * the creator's own active private row in exactly this workspace; any other
 * shape is left to the reconciler. Returns true only when this call changed
 * the row. Synchronous and local-only, so the caller orders it strictly before
 * the publication transaction that enqueues the backfill.
 */
export function markPublishedTeamProjectVisible(
  db: Database.Database,
  projectId: string,
  principal: ResourceHubPrincipal,
): boolean {
  return db.transaction(() => {
    const binding = getWorkspaceProjectByProjectId(db, projectId);
    if (
      !binding
      || binding.workspaceId !== principal.teamId
      || binding.visibility !== 'personal'
      || binding.resourceState !== 'active'
      || binding.createdByWorkspaceMemberId !== principal.memberId
    ) return false;
    rebindWorkspaceProject(db, projectId, {
      workspaceId: principal.teamId,
      visibility: 'team',
      createdByWorkspaceMemberId: principal.memberId,
      updatedByWorkspaceMemberId: principal.memberId,
      resourceHubResourceId: projectResourceIdFor(projectId, principal),
      cloudTombstonedAt: null,
      syncState: 'synced',
    });
    ensureTeamProjectCommentConversations(db, projectId);
    return true;
  })();
}
