// C3-LITE member comment paging, end to end on the daemon side:
// real HTTP adapter (fetch stub) → drain in collab-cloud-service → atomic
// SQLite page commit in comment-inbound-store → preview_comments.
//
// The fake cloud below reproduces the response shapes and paging rules of
// C3-LITE §3 (snapshot = latest event per comment with seq ≤ W, comment_id
// DESCENDING keyset; incremental = seq ascending, scans every author kind but
// returns member events only; minimal tombstones; stateless `c3l1.` tokens)
// and the §4 error bodies.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import {
  closeDatabase,
  confirmPreviewCommentPinSeq,
  getProjectPreviewComment,
  insertConversation,
  insertProject,
  listPreviewComments,
  mergeSyncedPreviewComment,
  openDatabase,
  upsertPreviewComment,
} from '../src/db.js';
import { createCollabCloudClient, parseMemberPage } from '../src/integrations/collab-cloud.js';
import { createCollabCloudService } from '../src/collab/collab-cloud-service.js';
import {
  createCommentInboundStore,
  readMemberSyncCursor,
  type MemberSyncScope,
} from '../src/collab/comment-inbound-store.js';

type Db = ReturnType<typeof openDatabase>;
type CloudEvent = { seq: number; commentId: string; authorKind: 'member' | 'user'; memberId: string; payload: Record<string, unknown> };

const EPOCH = 'k3J0cV9aQm1zYQ';
const SCOPE_TOKEN = 'c3ls.QxTeamProjectMember';
const token = (body: Record<string, unknown>) => `c3l1.${Buffer.from(JSON.stringify(body)).toString('base64url')}`;
const readToken = (value: string) => JSON.parse(Buffer.from(value.slice(5), 'base64url').toString()) as Record<string, any>;

/** Stored payload as a member daemon pushes it (previewCommentToCloud shape). */
function payload(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, projectId: 'p1', conversationId: 'conv-remote', memberId: 'm-author', seq: 0,
    note: `note ${id}`, filePath: 'index.html', elementId: 'hero', selector: '#hero', label: 'h1.hero',
    text: 'Hero', htmlHint: '<h1>', position: { x: 1, y: 2, width: 3, height: 4 }, status: 'open',
    createdAt: 100, updatedAt: 100, ...patch,
  };
}

class FakeCloud {
  events: CloudEvent[] = [];
  epoch = EPOCH;
  requests: URLSearchParams[] = [];
  legacyRequests = 0;
  /** Override one request's response (status + JSON body). */
  failNext: Array<{ status: number; body: unknown }> = [];
  /** Awaited after computing, before returning, a paged response. */
  gate: (() => Promise<void>) | null = null;

  get head() { return this.events.length; }
  write(commentId: string, patch: Record<string, unknown> = {}, authorKind: 'member' | 'user' = 'member') {
    const seq = this.head + 1;
    this.events.push({ seq, commentId, authorKind, memberId: 'm-author', payload: payload(commentId, { updatedAt: 100 + seq, ...patch }) });
    return seq;
  }
  remove(commentId: string, authorKind: 'member' | 'user' = 'member') {
    this.events.push({ seq: this.head + 1, commentId, authorKind, memberId: 'm-deleter', payload: { id: commentId, deleted: true } });
  }
  private project(event: CloudEvent) {
    if (event.payload.deleted === true) return { id: event.commentId, projectId: 'p1', seq: event.seq, deleted: true };
    const { authorKind: _k, author: _a, ...body } = event.payload;
    return { ...body, id: event.commentId, projectId: 'p1', seq: event.seq, memberId: event.memberId,
      authorKind: 'member', authorDisplayName: 'Ada', author: { displayName: 'Ada' } };
  }
  pagedResponse(query: URLSearchParams): { status: number; body: unknown } {
    const failure = this.failNext.shift();
    if (failure) return failure;
    const mode = query.get('mode');
    const limit = Number(query.get('limit') ?? 100);
    const pageToken = query.get('pageToken');
    const resumeToken = query.get('resumeToken');
    const cursor = pageToken ?? resumeToken;
    const decoded = cursor ? readToken(cursor) : null;
    // Server rule (assertCursorCurrent): position 0 is valid under any epoch.
    const position = decoded ? (decoded.sinceSeq ?? decoded.snapshotAt) : 0;
    if (decoded && position !== 0 && decoded.streamEpoch !== this.epoch) {
      return { status: 409, body: { error: 'CURSOR_STALE', reason: 'stream epoch changed' } };
    }
    const base = { scopeToken: SCOPE_TOKEN, streamEpoch: this.epoch, latestSeq: this.head };
    if (mode === 'snapshot') {
      const W = decoded?.snapshotAt ?? this.head;
      const latest = new Map<string, CloudEvent>();
      for (const event of this.events) if (event.seq <= W) latest.set(event.commentId, event);
      const ordered = [...latest.values()].sort((a, b) => (a.commentId < b.commentId ? 1 : -1))
        .filter(event => decoded?.afterCommentId === undefined || event.commentId < decoded.afterCommentId);
      const rows = ordered.slice(0, limit);
      const hasMore = ordered.length > limit;
      const resume = hasMore ? null : token({ mode: 'incremental', sinceSeq: W, streamEpoch: this.epoch });
      return { status: 200, body: {
        mode: 'snapshot', comments: rows.filter(e => e.authorKind === 'member').map(e => this.project(e)),
        hasMore, complete: !hasMore,
        nextPageToken: hasMore ? token({ mode: 'snapshot', snapshotAt: W, afterCommentId: rows.at(-1)!.commentId, streamEpoch: this.epoch }) : null,
        resumeToken: resume, ...base, watermarkSeq: W, scanThroughSeq: W,
        handoff: resume ? { sinceSeq: W, resumeToken: resume, scopeToken: SCOPE_TOKEN } : null,
        nextSeq: hasMore ? null : W, snapshotAt: W,
      } };
    }
    const since = decoded!.sinceSeq as number;
    const head = this.head;
    const range = this.events.filter(e => e.seq > since && e.seq <= head);
    const rows = range.slice(0, limit);
    const hasMore = range.length > limit;
    const scanThroughSeq = hasMore ? rows.at(-1)!.seq : head;
    const next = token({ mode: 'incremental', sinceSeq: scanThroughSeq, streamEpoch: this.epoch });
    return { status: 200, body: {
      mode: 'incremental', comments: rows.filter(e => e.authorKind === 'member').map(e => this.project(e)),
      hasMore, complete: !hasMore, nextPageToken: hasMore ? next : null, resumeToken: hasMore ? null : next,
      ...base, watermarkSeq: head, scanThroughSeq, handoff: null, nextSeq: scanThroughSeq, snapshotAt: null,
    } };
  }
  legacyResponse(sinceSeq: number) {
    this.legacyRequests += 1;
    const comments = this.events.filter(e => e.seq > sinceSeq).map(e => (
      e.payload.deleted === true
        ? { id: e.commentId, projectId: 'p1', seq: e.seq, deleted: true }
        : { ...e.payload, seq: e.seq, authorKind: e.authorKind, memberId: e.authorKind === 'user' ? '' : e.memberId }
    ));
    return { comments, latestSeq: this.head };
  }
  fetch = async (input: unknown) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/api/v1/collab/projects/')) {
      this.requests.push(url.searchParams);
      // The response is computed first: a held request models one whose head
      // was already read when a concurrent write committed.
      const { status, body } = this.pagedResponse(url.searchParams);
      if (this.gate) await this.gate();
      return new Response(JSON.stringify(body), { status });
    }
    return new Response(JSON.stringify(this.legacyResponse(Number(url.searchParams.get('sinceSeq') ?? 0))), { status: 200 });
  };
}

let tempDir: string | null = null;
afterEach(() => {
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function seededDb(): Db {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-member-sync-'));
  const db = openDatabase(tempDir);
  insertProject(db, { id: 'p1', name: 'Project', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 'conv-local', projectId: 'p1', title: 'Chat', createdAt: 1, updatedAt: 1 });
  return db;
}

function teamContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-1', workspaceType: 'team', workspaceMemberId: 'm-self', role: 'member',
    memberStatus: 'active', lifecycleState: 'active', billingState: 'active', planId: null,
    providerMode: 'platform_credits', seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
    teamId: 'team-1', displayName: 'Self',
  };
}
const SCOPE: MemberSyncScope = { workspaceId: 'ws-1', memberId: 'm-self', teamId: 'team-1', projectId: 'p1' };

function harness(db: Db, cloud: FakeCloud, options: { merge?: (id: string) => void } = {}) {
  const onMerged = vi.fn();
  const onError = vi.fn();
  const onMemberSyncRebuildRequired = vi.fn();
  const merged: string[] = [];
  const service = createCollabCloudService({
    client: createCollabCloudClient({ config: { baseUrl: 'https://cloud.test', token: null }, fetch: cloud.fetch as typeof fetch }),
    memberCommentStore: createCommentInboundStore(db),
    listProjectIds: () => [],
    resolveLocalConversationId: () => 'conv-local',
    mergeComment: ({ projectId, conversationId, comment }) => {
      options.merge?.(comment.id);
      merged.push(comment.id);
      return mergeSyncedPreviewComment(db, projectId, conversationId, comment);
    },
    onMerged, onError, onMemberSyncRebuildRequired,
  });
  return { service, onMerged, onError, onMemberSyncRebuildRequired, merged };
}

const ids = (db: Db) => listPreviewComments(db, 'p1', 'conv-local').map(c => c.id).sort();
const pad = (n: number) => `c${String(n).padStart(3, '0')}`;

describe('C3-LITE member page drain', () => {
  it('drains a >100 comment snapshot across pages, then hands off to an incremental round', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    for (let i = 0; i < 250; i += 1) cloud.write(pad(i));
    const { service, onMerged } = harness(db, cloud);

    await expect(service.pullProject('p1', teamContext())).resolves.toBe(true);

    expect(ids(db)).toHaveLength(250);
    const modes = cloud.requests.map(q => q.get('mode'));
    expect(modes).toEqual(['snapshot', 'snapshot', 'snapshot', 'incremental']);
    expect(cloud.requests.every(q => q.get('authorKinds') === 'member' && q.get('limit') === '100')).toBe(true);
    // The first snapshot page is DESCENDING by comment id.
    expect(onMerged.mock.calls.map(([arg]) => arg.inserted)).toEqual([100, 100, 50]);
    const cursor = readMemberSyncCursor(db, SCOPE)!;
    expect(cursor).toMatchObject({ phase: 'incremental', pageToken: null, streamEpoch: EPOCH, scopeToken: SCOPE_TOKEN, watermarkSeq: 250 });
    expect(readToken(cursor.resumeToken!)).toMatchObject({ sinceSeq: 250 });
    // pin_seq is the cloud seq; memberId is the ORIGINAL author.
    expect(getProjectPreviewComment(db, 'p1', 'c007')).toMatchObject({ authorMemberId: 'm-author', pinSeq: 8 });
  });

  it('picks up a write committed during the snapshot through the handoff resume token', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    for (let i = 0; i < 120; i += 1) cloud.write(pad(i));
    let served = 0;
    cloud.gate = async () => {
      served += 1;
      if (served === 2) { cloud.write('z-late'); cloud.write(pad(5), { note: 'edited during snapshot', updatedAt: 999 }); }
    };
    const { service } = harness(db, cloud);
    await service.pullProject('p1', teamContext());
    expect(ids(db)).toContain('z-late');
    expect(getProjectPreviewComment(db, 'p1', pad(5))?.note).toBe('edited during snapshot');
    expect(cloud.requests.map(q => q.get('mode'))).toEqual(['snapshot', 'snapshot', 'incremental']);
  });

  it('continues through an empty page with hasMore:true', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    const { service } = harness(db, cloud);
    await service.pullProject('p1', teamContext()); // empty snapshot, W=0
    for (let i = 0; i < 150; i += 1) cloud.write(`share-${i}`, {}, 'user');
    cloud.write('member-after-shares');
    cloud.requests = [];

    await service.pullProject('p1', teamContext());

    expect(cloud.requests).toHaveLength(2);
    expect(getProjectPreviewComment(db, 'p1', 'member-after-shares')).toBeTruthy();
    expect(readToken(readMemberSyncCursor(db, SCOPE)!.resumeToken!).sinceSeq).toBe(151);
  });

  it('applies a minimal tombstone and treats a tombstone for an unknown comment as a no-op', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.write('keep');
    cloud.write('gone');
    const { service } = harness(db, cloud);
    await service.pullProject('p1', teamContext());
    expect(ids(db)).toEqual(['gone', 'keep']);

    cloud.remove('gone');
    cloud.remove('never-seen');
    await service.pullProject('p1', teamContext());

    expect(ids(db)).toEqual(['keep']);
    expect(readToken(readMemberSyncCursor(db, SCOPE)!.resumeToken!).sinceSeq).toBe(4);
  });

  it('snapshot replays historical tombstones without touching unknown ids', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.write('a');
    cloud.remove('a');
    cloud.write('b');
    const { service } = harness(db, cloud);
    await service.pullProject('p1', teamContext());
    expect(ids(db)).toEqual(['b']);
  });

  it('deletes rows with a pin_seq on a remote tombstone, even before our push is confirmed (67 #5)', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    const { service } = harness(db, cloud);
    await service.pullProject('p1', teamContext());
    const local = (id: string) => upsertPreviewComment(db, 'p1', 'conv-local', {
      id, note: id, target: { filePath: 'index.html', elementId: 'e', selector: '#e', label: 'E', position: { x: 0, y: 0, width: 1, height: 1 } },
    }, { pinPendingCloudConfirm: true });
    local('pushed-confirmed');
    local('pending-push');
    local('no-pin');
    expect(confirmPreviewCommentPinSeq(db, 'p1', 'pushed-confirmed', 41)).toBe(true);
    db.prepare('UPDATE preview_comments SET pin_seq=NULL WHERE id=?').run('no-pin');
    for (const id of ['pushed-confirmed', 'pending-push', 'no-pin']) cloud.remove(id);

    await service.pullProject('p1', teamContext());

    // A teammate may delete our comment before our push's seq is written back.
    expect(ids(db)).toEqual(['no-pin']);
  });

  it('skips one malformed stored comment, applies the rest of the page and advances', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.write('ok-1');
    cloud.write('broken', { position: undefined, updatedAt: undefined });
    cloud.write('legacy-sparse', { conversationId: undefined, label: undefined, htmlHint: undefined, text: undefined });
    const { service, onError } = harness(db, cloud);

    await expect(service.pullProject('p1', teamContext())).resolves.toBe(true);

    expect(ids(db)).toEqual(['legacy-sparse', 'ok-1']);
    const cursor = readMemberSyncCursor(db, SCOPE)!;
    expect(cursor).toMatchObject({ phase: 'incremental', skippedCount: 1 });
    expect(String(onError.mock.calls.at(0)?.[0])).toMatch(/broken/);
    // The next incremental round does not re-request the skipped item.
    cloud.requests = [];
    await service.pullProject('p1', teamContext());
    expect(readMemberSyncCursor(db, SCOPE)!.skippedCount).toBe(1);
  });

  it.each([
    [409, 'CURSOR_STALE'],
    [409, 'SCOPE_CHANGED'],
    [400, 'INVALID_CURSOR'],
  ])('signals rebuild on %s %s without moving the cursor, and keeps legacy delivery', async (status, code) => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.write('first');
    const { service, onMemberSyncRebuildRequired } = harness(db, cloud);
    await service.pullProject('p1', teamContext());
    const before = readMemberSyncCursor(db, SCOPE);
    cloud.write('second');
    cloud.failNext.push({ status, body: { error: code, reason: 'test' } });

    await expect(service.pullProject('p1', teamContext())).resolves.toBe(true);

    expect(onMemberSyncRebuildRequired).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', code }));
    expect(readMemberSyncCursor(db, SCOPE)).toEqual(before);
    // Nothing regresses: the legacy pull still delivers the member comment.
    expect(ids(db)).toContain('second');
    // Latched until BO2 rebuilds: no paged request, no repeated warning.
    const requests = cloud.requests.length;
    cloud.write('third');
    await service.pullProject('p1', teamContext());
    expect(cloud.requests).toHaveLength(requests);
    expect(onMemberSyncRebuildRequired).toHaveBeenCalledTimes(1);
    expect(ids(db)).toContain('third');
  });

  it('replays the legacy stream when paging stops covering members after having filtered them', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.write('first');
    const { service } = harness(db, cloud);
    await service.pullProject('p1', teamContext()); // drained: legacy skipped 'first'
    cloud.write('second');
    await service.pullProject('p1', teamContext()); // drained again: legacy cursor now past 'second'
    db.prepare("DELETE FROM preview_comments WHERE id='second'").run();
    cloud.failNext.push({ status: 409, body: { error: 'SCOPE_CHANGED', reason: 'test' } });
    await service.pullProject('p1', teamContext());
    // Legacy restarted from zero, so the member comment it skipped earlier returns.
    expect(ids(db)).toEqual(['first', 'second']);
  });

  it('keeps delivering member comments through the legacy pull when paged mode is unsupported', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.write('member-1');
    // An older server ignores `mode` and answers with the legacy body.
    cloud.failNext.push({ status: 200, body: { comments: [], latestSeq: 1 } });
    const { service, onError } = harness(db, cloud);
    await expect(service.pullProject('p1', teamContext())).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/Invalid member page response/) }));
    expect(ids(db)).toEqual(['member-1']);
  });

  it('continues after a first snapshot taken before the stream existed (epoch "0")', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.epoch = '0';
    const { service, onMemberSyncRebuildRequired } = harness(db, cloud);
    await service.pullProject('p1', teamContext());
    expect(readMemberSyncCursor(db, SCOPE)?.streamEpoch).toBe('0');
    // The first comment creates the stream; position 0 is valid under any epoch.
    cloud.epoch = EPOCH;
    cloud.write('first-ever');
    await service.pullProject('p1', teamContext());
    expect(onMemberSyncRebuildRequired).not.toHaveBeenCalled();
    expect(readMemberSyncCursor(db, SCOPE)).toMatchObject({ streamEpoch: EPOCH });
    expect(ids(db)).toEqual(['first-ever']);
  });

  it('detects a stream epoch change on a stored cursor as rebuild-required', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.write('first');
    const { service, onMemberSyncRebuildRequired } = harness(db, cloud);
    await service.pullProject('p1', teamContext());
    const before = readMemberSyncCursor(db, SCOPE);
    cloud.epoch = 'rebuiltStream01';
    await service.pullProject('p1', teamContext());
    expect(onMemberSyncRebuildRequired).toHaveBeenCalledWith(expect.objectContaining({ code: 'CURSOR_STALE' }));
    expect(readMemberSyncCursor(db, SCOPE)).toEqual(before);
  });

  it('treats 400 INVALID_PAGE_REQUEST as an error, not a rebuild', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.failNext.push({ status: 400, body: { error: 'INVALID_PAGE_REQUEST', reason: 'limit' } });
    const { service, onError, onMemberSyncRebuildRequired } = harness(db, cloud);
    await service.pullProject('p1', teamContext());
    expect(onMemberSyncRebuildRequired).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 400, code: 'INVALID_PAGE_REQUEST' }));
    expect(readMemberSyncCursor(db, SCOPE)).toBeNull();
  });

  it('keeps the cursor on the last committed page when a crash interrupts the drain, then resumes there', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    for (let i = 0; i < 250; i += 1) cloud.write(pad(i));
    let crash = true;
    // Descending snapshot: page 2 holds c149..c050. The fault hits once.
    const { service, onMerged } = harness(db, cloud, { merge: id => { if (crash && id === pad(100)) { crash = false; throw new Error('disk full'); } } });

    // A failed drain is not a redeemed wake: the caller must keep its mark.
    await expect(service.pullProject('p1', teamContext())).resolves.toBe(false);

    const cursor = readMemberSyncCursor(db, SCOPE)!;
    expect(cursor.phase).toBe('snapshot');
    expect(readToken(cursor.pageToken!)).toMatchObject({ afterCommentId: pad(150) });
    // Page 1 landed whole; page 2's rows were rolled back with its cursor.
    expect(onMerged.mock.calls[0]![0].inserted).toBe(100);
    // The legacy pull covered the gap meanwhile, so no comment is missing.
    expect(ids(db)).toHaveLength(250);

    cloud.requests = [];
    await expect(service.pullProject('p1', teamContext())).resolves.toBe(true);
    expect(cloud.requests[0]!.get('pageToken')).toBe(cursor.pageToken);
    expect(readMemberSyncCursor(db, SCOPE)).toMatchObject({ phase: 'incremental', pageToken: null });
  });

  it('never advances the cursor on a failed transport call', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.write('a');
    const { service } = harness(db, cloud);
    await service.pullProject('p1', teamContext());
    const before = readMemberSyncCursor(db, SCOPE);
    cloud.write('b');
    cloud.failNext.push({ status: 503, body: { error: 'UNAVAILABLE' } });
    await service.pullProject('p1', teamContext());
    expect(readMemberSyncCursor(db, SCOPE)).toEqual(before);
  });

  it('runs one trailing drain when a wake arrives during a pull', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.write('before');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let served = 0;
    // Hold the handoff incremental page: its head was read before 'during'.
    cloud.gate = async () => { served += 1; if (served === 2) await held; };
    const { service } = harness(db, cloud);

    const running = service.pullProject('p1', teamContext());
    await vi.waitFor(() => expect(cloud.requests).toHaveLength(2));
    cloud.write('during');
    const wake = service.pullProject('p1', teamContext());
    const extraWake = service.pullProject('p1', teamContext());
    release();

    await expect(Promise.all([running, wake, extraWake])).resolves.toEqual([true, true, true]);
    expect(ids(db)).toEqual(['before', 'during']);
    // Two coalesced wakes buy exactly one extra drain (snapshot+incremental, then one incremental).
    expect(cloud.requests.map(q => q.get('mode'))).toEqual(['snapshot', 'incremental', 'incremental']);
  });

  it('replaying an already applied state produces no second merge notification', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.write('a');
    cloud.write('b');
    const { service, onMerged } = harness(db, cloud);
    await service.pullProject('p1', teamContext());
    expect(onMerged).toHaveBeenCalledTimes(1);
    // Same events arriving again (e.g. a rebuild snapshot) are LWW no-ops.
    await service.pullProject('p1', teamContext());
    db.prepare('DELETE FROM comment_member_sync_cursor').run();
    await service.pullProject('p1', teamContext());
    expect(onMerged).toHaveBeenCalledTimes(1);
  });

  it('keeps share-page (user) comments on the legacy pull and does not double-apply member comments', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.write('member-1');
    cloud.write('share-1', { memberId: '' }, 'user');
    const { service, merged } = harness(db, cloud);
    await service.pullProject('p1', teamContext());
    expect(ids(db)).toEqual(['member-1', 'share-1']);
    expect(cloud.legacyRequests).toBe(1);
    expect(merged.filter(id => id === 'member-1')).toHaveLength(1);
  });
});

describe('parseMemberPage (C3-LITE §3 example)', () => {
  const example = {
    mode: 'snapshot',
    comments: [],
    hasMore: false, complete: true,
    nextPageToken: null,
    resumeToken: 'c3l1.eyJr',
    scopeToken: 'c3ls.Qx',
    watermarkSeq: 151,
    scanThroughSeq: 151,
    handoff: { sinceSeq: 151, resumeToken: 'c3l1.eyJr', scopeToken: 'c3ls.Qx' },
    streamEpoch: 'k3J0cV9aQm1zYQ',
    latestSeq: 154,
    nextSeq: 151,
    snapshotAt: 151,
  };

  it('accepts the documented terminal snapshot envelope', () => {
    expect(parseMemberPage(example, 'snapshot', 'p1')).toMatchObject({ resumeToken: 'c3l1.eyJr', streamEpoch: 'k3J0cV9aQm1zYQ', latestSeq: 154, skipped: [] });
  });

  it('keeps a minimal tombstone and fills its projectId from scope', () => {
    const page = parseMemberPage({ ...example, comments: [{ id: 'gone', seq: 9, deleted: true }] }, 'snapshot', 'p1');
    expect(page.comments).toEqual([{ id: 'gone', projectId: 'p1', seq: 9, deleted: true }]);
  });

  it('skips per item instead of rejecting the page', () => {
    const page = parseMemberPage({ ...example, comments: [{}, { id: 'x', seq: 1, deleted: true, projectId: 'other' }] }, 'snapshot', 'p1');
    expect(page.comments).toEqual([]);
    expect(page.skipped.map(s => s.reason)).toEqual(['id missing', 'projectId does not match the requested project']);
  });

  it('rejects an incoherent envelope', () => {
    for (const bad of [
      { ...example, handoff: null },
      { ...example, streamEpoch: undefined },
      { ...example, complete: false },
      { ...example, hasMore: true, complete: false },
      { ...example, mode: 'incremental' },
    ]) expect(() => parseMemberPage(bad, 'snapshot', 'p1')).toThrow(/Invalid member page response/);
  });
});

describe('comment-inbound-store page commit', () => {
  const terminal = (patch: Record<string, unknown> = {}) => parseMemberPage({
    mode: 'snapshot', comments: [], hasMore: false, complete: true, nextPageToken: null,
    resumeToken: 'c3l1.r1', scopeToken: SCOPE_TOKEN, watermarkSeq: 3, scanThroughSeq: 3,
    handoff: { sinceSeq: 3, resumeToken: 'c3l1.r1', scopeToken: SCOPE_TOKEN }, streamEpoch: EPOCH, ...patch,
  }, 'snapshot', 'p1');
  const incremental = (patch: Record<string, unknown> = {}) => parseMemberPage({
    mode: 'incremental', comments: [], hasMore: false, complete: true, nextPageToken: null,
    resumeToken: 'c3l1.r2', scopeToken: SCOPE_TOKEN, watermarkSeq: 4, scanThroughSeq: 4, handoff: null,
    streamEpoch: EPOCH, ...patch,
  }, 'incremental', 'p1');
  const merge = (db: Db) => (comment: any) => mergeSyncedPreviewComment(db, 'p1', 'conv-local', comment);

  it('persists the resume token across a daemon restart', () => {
    const db = seededDb();
    const store = createCommentInboundStore(db);
    expect(store.apply({ scope: SCOPE, query: { mode: 'snapshot' }, page: terminal(), merge: merge(db) })).toMatchObject({ status: 'committed' });
    closeDatabase();
    const reopened = openDatabase(tempDir!);
    expect(readMemberSyncCursor(reopened, SCOPE)).toMatchObject({ phase: 'incremental', resumeToken: 'c3l1.r1', pageToken: null });
  });

  it('rejects a page that does not answer the cursor’s next query (CAS)', () => {
    const db = seededDb();
    const store = createCommentInboundStore(db);
    store.apply({ scope: SCOPE, query: { mode: 'snapshot' }, page: terminal(), merge: merge(db) });
    // A duplicate/late snapshot page after the handoff.
    expect(store.apply({ scope: SCOPE, query: { mode: 'snapshot' }, page: terminal(), merge: merge(db) })).toEqual({ status: 'conflict' });
    expect(store.apply({ scope: SCOPE, query: { mode: 'incremental', resumeToken: 'c3l1.other' }, page: incremental(), merge: merge(db) })).toEqual({ status: 'conflict' });
    // A different member/workspace has no cursor of its own yet.
    expect(readMemberSyncCursor(db, { ...SCOPE, memberId: 'm-other' })).toBeNull();
  });

  it('refuses a page from another scope without touching the cursor, and leaves epoch checks to the server', () => {
    const db = seededDb();
    const store = createCommentInboundStore(db);
    store.apply({ scope: SCOPE, query: { mode: 'snapshot' }, page: terminal(), merge: merge(db) });
    const before = readMemberSyncCursor(db, SCOPE);
    const query = { mode: 'incremental' as const, resumeToken: 'c3l1.r1' };
    const comment = { ...payload('late'), seq: 4, memberId: 'm-author' };
    expect(store.apply({ scope: SCOPE, query, page: incremental({ scopeToken: 'c3ls.other', comments: [comment] }), merge: merge(db) }))
      .toEqual({ status: 'rebuild-required', reason: 'scope-changed' });
    expect(readMemberSyncCursor(db, SCOPE)).toEqual(before);
    expect(getProjectPreviewComment(db, 'p1', 'late')).toBeNull();
    expect(store.apply({ scope: SCOPE, query, page: incremental({ streamEpoch: 'newStream', comments: [comment] }), merge: merge(db) }))
      .toMatchObject({ status: 'committed', cursor: { streamEpoch: 'newStream' } });
  });

  it('rolls back rows and cursor when a merge is not acknowledged', () => {
    const db = seededDb();
    const store = createCommentInboundStore(db);
    const page = terminal({ comments: [{ ...payload('a'), seq: 1 }, { ...payload('b'), seq: 2 }] });
    let calls = 0;
    expect(() => store.apply({ scope: SCOPE, query: { mode: 'snapshot' }, page, merge: (c) => {
      calls += 1;
      return calls === 1 ? mergeSyncedPreviewComment(db, 'p1', 'conv-local', c) : (undefined as never);
    } })).toThrow(/acknowledged/);
    expect(readMemberSyncCursor(db, SCOPE)).toBeNull();
    expect(getProjectPreviewComment(db, 'p1', 'a')).toBeNull();
  });
});

describe('legacy pull alongside member paging', () => {
  it('still applies a share-page comment tombstone from the legacy pull', async () => {
    const db = seededDb();
    const cloud = new FakeCloud();
    cloud.write('share-1', { memberId: '' }, 'user');
    const { service } = harness(db, cloud);
    await service.pullProject('p1', teamContext());
    expect(ids(db)).toEqual(['share-1']);
    cloud.remove('share-1', 'user');
    cloud.requests = [];
    await service.pullProject('p1', teamContext());
    // The member stream skipped the share-page delete; the legacy pull applied it.
    expect(ids(db)).toEqual([]);
    expect(cloud.requests.map(q => q.get('mode'))).toEqual(['incremental']);
  });
});
