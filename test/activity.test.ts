import { describe, expect, it, vi } from 'vitest';
import { ActivityService, activityStats, calendarDate } from '../src/activity';
import { activityConfig } from '../src/activity-config';
import { GitHubClient } from '../src/github';
import { SettingsService } from '../src/settings';
import { FakeR2Bucket } from './fake-r2';
import type { Env } from '../src/types';

function setup() {
  const bucket = new FakeR2Bucket();
  const env = { GITHUB_OWNER: 'owner', GITHUB_REPO: 'blog', GITHUB_BRANCH: 'feature/blog', POSTS_DIRECTORY: 'content/posts', GITHUB_TOKEN: 'TOP_SECRET', MEDIA: bucket.asBucket() } as Env;
  let now = new Date('2026-10-03T02:00:00Z');
  const config = { enabled: true, title: '代码足迹', days: 30, timezone: 'Asia/Hong_Kong', github: { enabled: true, title: '提交活动' } };
  const read = vi.fn(async () => ({ value: { activity: config } }));
  const commits = vi.fn(async () => [{ sha: 'a'.repeat(40), date: '2026-10-02T16:01:00Z' }, { sha: 'b'.repeat(40), date: '2026-10-02T15:59:00Z' }]);
  const service = new ActivityService(env, { listCommitDates: commits } as unknown as GitHubClient, { read } as unknown as SettingsService, () => now);
  return { service, env, bucket, config, read, commits, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); } };
}
describe('repository activity', () => {
  it('groups committer timestamps in the configured calendar zone and exposes only aggregate counts', async () => {
    const { service, commits } = setup(); const result = await service.read();
    expect(result.range).toEqual({ from: '2026-09-04', to: '2026-10-03', days: 30 });
    expect(result.github.daily!.slice(-2)).toEqual([{ date: '2026-10-02', count: 1 }, { date: '2026-10-03', count: 1 }]);
    expect(result.github.stats).toMatchObject({ total: 2, activeDays: 2, currentStreakDays: 2, longestStreakDays: 2 });
    expect(result.github.url).toContain('feature%2Fblog');
    expect(commits.mock.calls[0]).toEqual(['2026-09-03T00:00:00.000Z', '2026-10-03T02:00:00.000Z']);
    expect(JSON.stringify(result)).not.toContain('TOP_SECRET'); expect(JSON.stringify(result)).not.toContain('a'.repeat(40));
    expect(calendarDate(new Date('2026-03-08T07:30:00Z'), 'America/Los_Angeles')).toBe('2026-03-07');
  });
  it('keeps a streak through yesterday, but resets it after an inactive yesterday', () => {
    expect(activityStats([{ date: 'a', count: 1 }, { date: 'b', count: 3 }, { date: 'c', count: 0 }])).toEqual({ total: 4, activeDays: 2, peakDaily: 3, longestStreakDays: 2, currentStreakDays: 2 });
    expect(activityStats([{ date: 'a', count: 1 }, { date: 'b', count: 0 }, { date: 'c', count: 0 }]).currentStreakDays).toBe(0);
  });
  it('reuses R2 statistics but rereads settings, so disabling never restores old activity', async () => {
    const { service, config, commits, read } = setup(); await service.read(); await service.read();
    expect(commits).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(2);
    config.enabled = false; expect((await service.read()).github.status).toBe('disabled'); expect(commits).toHaveBeenCalledTimes(1);
    config.enabled = true; config.github.enabled = false; expect((await service.read()).enabled).toBe(false);
  });
  it('labels yesterday’s cached range stale, backs off failures and expires old statistics', async () => {
    const { service, commits, advance } = setup(); await service.read(); advance(23 * 3600000);
    commits.mockRejectedValue(new Error('TOP_SECRET upstream body'));
    const stale = await service.read(); expect(stale.github.status).toBe('stale'); expect(stale.range.to).toBe('2026-10-03');
    expect(stale.github.stats!.total).toBe(2); expect(JSON.stringify(stale)).not.toContain('TOP_SECRET');
    await service.read(); expect(commits).toHaveBeenCalledTimes(2);
    advance(2 * 3600000); const expired = await service.read(); expect(expired.github.status).toBe('unavailable'); expect(expired.github.daily).toBeNull(); expect(expired.github.stats).toBeNull();
  });
  it('distinguishes a truly empty interval from an unavailable upstream and tolerates optional cache failure', async () => {
    const good = setup(); good.commits.mockResolvedValue([]); vi.spyOn(good.bucket, 'put').mockRejectedValue(new Error('cache offline'));
    expect((await good.service.read()).github.stats!.total).toBe(0);
    const bad = setup(); bad.commits.mockRejectedValue(new Error('network')); const failed = await bad.service.read();
    expect(failed.github.status).toBe('unavailable'); expect(failed.github.stats).toBeNull(); await bad.service.read(); expect(bad.commits).toHaveBeenCalledTimes(1);
    const settings = setup(); settings.read.mockRejectedValue(new Error('credential revoked')); await expect(settings.service.read()).rejects.toThrow('credential revoked');
  });
  it('validates global activity fields and keeps old configurations disabled', () => {
    expect(activityConfig(undefined).enabled).toBe(false);
    const valid = setup().config;
    for (const value of [{ ...valid, days: 367 }, { ...valid, days: 3.5 }, { ...valid, timezone: 'not/a/zone' }, { ...valid, enabled: 'yes' }, { ...valid, github: { enabled: true, title: '' } }, { ...valid, token: {} }]) expect(() => activityConfig(value)).toThrow();
  });
});
describe('bounded GitHub commit history', () => {
  const head = 'f'.repeat(40), sha = 'a'.repeat(40);
  const env = setup().env;
  const response = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
  const commit = { sha, commit: { committer: { date: '2026-10-02T00:00:00Z' }, author: { date: '2000-01-01T00:00:00Z' }, message: 'PRIVATE MESSAGE' } };
  it('pins pages to one HEAD, deduplicates SHAs and does not follow arbitrary Link hosts', async () => {
    const calls: { url: URL; signal: AbortSignal | null | undefined }[] = [];
    const fetcher = vi.fn(async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      expect(this).toBe(globalThis); const url = new URL(String(input)); calls.push({ url, signal: init?.signal });
      if (url.pathname.includes('/git/ref/')) return response({ object: { type: 'commit', sha: head } });
      if (url.searchParams.get('page') === '1') return response([commit], 200, { Link: '<https://evil.example/secret>; rel="next"' });
      return response([commit, { ...commit, sha: 'b'.repeat(40) }]);
    });
    const items = await new GitHubClient(env, fetcher as typeof fetch).listCommitDates('2026-09-01T00:00:00Z', '2026-10-03T00:00:00Z');
    expect(items).toHaveLength(2); expect(items[0].date).toBe('2026-10-02T00:00:00.000Z');
    expect(calls.slice(1).every(call => call.url.hostname === 'api.github.com' && call.url.searchParams.get('sha') === head)).toBe(true);
    expect(calls.every(call => call.signal === calls[0].signal)).toBe(true); expect(JSON.stringify(items)).not.toContain('PRIVATE');
  });
  it('rejects incomplete, malformed and denied histories instead of returning zero counts', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/git/ref/') ? response({ object: { type: 'commit', sha: head } }) : response([commit], 200, { Link: '<https://api.github.com/next>; rel="next"' }));
    await expect(new GitHubClient(env, fetcher as typeof fetch).listCommitDates('a', 'b')).rejects.toMatchObject({ code: 'ACTIVITY_TOO_LARGE' }); expect(fetcher).toHaveBeenCalledTimes(21);
    const malformed = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/git/ref/') ? response({ object: { type: 'commit', sha: head } }) : response([{ ...commit, commit: { committer: { date: 'bad' } } }]));
    await expect(new GitHubClient(env, malformed as typeof fetch).listCommitDates('a', 'b')).rejects.toMatchObject({ code: 'GITHUB_INVALID_RESPONSE' });
    await expect(new GitHubClient(env, vi.fn(async () => response({ message: 'TOP_SECRET' }, 401)) as typeof fetch).listCommitDates('a', 'b')).rejects.toMatchObject({ code: 'GITHUB_ACCESS_DENIED' });
  });
  it('reports an empty repository only when GitHub confirms it', async () => {
    const fetcher = vi.fn(async () => response({}, 409));
    expect(await new GitHubClient(env, fetcher as typeof fetch).listCommitDates('a', 'b')).toEqual([]);
    await expect(new GitHubClient(env, vi.fn(async () => response({}, 404)) as typeof fetch).listCommitDates('a', 'b')).rejects.toMatchObject({ code: 'GITHUB_REPOSITORY_UNAVAILABLE' });
  });
});
