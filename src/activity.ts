import { activityConfig } from './activity-config';
import { GitHubClient, repositoryConfig } from './github';
import { SettingsService, SITE_PATH } from './settings';
import type { Env } from './types';

const DAY = 86400000, FRESH = 600000, STALE = DAY, RETRY = 60000;
export interface ActivityDay { date: string; count: number; }
export interface ActivityStats { total: number; activeDays: number; peakDaily: number; longestStreakDays: number; currentStreakDays: number; }
interface Snapshot { from: string; to: string; fetchedAt: number; daily: ActivityDay[]; }
interface Cache { version: 1; attemptedAt: number; snapshot: Snapshot | null; }
export function calendarDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (name: string) => parts.find(part => part.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function calendarDays(to: string, days: number): string[] {
  const end = Date.parse(to + 'T00:00:00Z');
  return Array.from({ length: days }, (_, index) => new Date(end - (days - 1 - index) * DAY).toISOString().slice(0, 10));
}
export function activityStats(daily: ActivityDay[]): ActivityStats {
  let total = 0, activeDays = 0, peakDaily = 0, longestStreakDays = 0, streak = 0;
  for (const day of daily) {
    total += day.count; peakDaily = Math.max(peakDaily, day.count);
    if (day.count > 0) { activeDays++; streak++; longestStreakDays = Math.max(longestStreakDays, streak); } else streak = 0;
  }
  let end = daily.length - 1;
  if (daily[end]?.count === 0) end--;
  let currentStreakDays = 0;
  for (; end >= 0 && daily[end].count > 0; end--) currentStreakDays++;
  return { total, activeDays, peakDaily, longestStreakDays, currentStreakDays };
}
function cacheValue(value: unknown, days: number, now: number): Cache | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Cache;
  if (data.version !== 1 || !Number.isFinite(data.attemptedAt) || data.attemptedAt > now + 60000) return null;
  if (data.snapshot !== null) {
    const saved = data.snapshot;
    if (!saved || !Number.isFinite(saved.fetchedAt) || saved.fetchedAt > now + 60000 || !/^\d{4}-\d{2}-\d{2}$/.test(saved.to) || !Array.isArray(saved.daily) || saved.daily.length !== days) return null;
    let dates: string[]; try { dates = calendarDays(saved.to, days); } catch { return null; }
    if (saved.to !== dates.at(-1) || saved.from !== dates[0] || saved.daily.some((day, index) => !day || day.date !== dates[index] || !Number.isSafeInteger(day.count) || day.count < 0 || day.count > 2000)) return null;
  }
  return data;
}
export class ActivityService {
  constructor(private readonly env: Env, private readonly github = new GitHubClient(env), private readonly settings = new SettingsService(env, github), private readonly clock = () => new Date()) {}
  async read() {
    // Always check authoritative settings before using statistics from R2.
    const site = (await this.settings.read(SITE_PATH)).value as Record<string, unknown>;
    const config = activityConfig(site.activity), now = this.clock(), time = now.getTime();
    const dates = calendarDays(calendarDate(now, config.timezone), config.days);
    const repository = repositoryConfig(this.env);
    const base = {
      enabled: config.enabled && config.github.enabled, title: config.title, timezone: config.timezone,
      range: { from: dates[0], to: dates.at(-1)!, days: config.days },
    };
    const source = { title: config.github.title, repository: repository.owner + '/' + repository.repo, branch: repository.branch,
      url: `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/commits/${encodeURIComponent(repository.branch)}/` };
    const unavailable = (status: 'disabled' | 'unavailable') => ({ ...base, github: { ...source, status, updatedAt: null, daily: null, stats: null } });
    if (!base.enabled) return unavailable('disabled');
    const key = 'cache/github-activity/v1/' + [repository.owner, repository.repo, repository.branch, config.timezone, String(config.days)].map(encodeURIComponent).join('/') + '.json';
    let cached: Cache | null = null;
    try {
      const file = await this.env.MEDIA.get(key);
      if (file) {
        if (file.size <= 65536) cached = cacheValue(await file.json(), config.days, time);
        else await file.body.cancel();
      }
    } catch { /* Statistics are rebuildable; a cache failure must not block GitHub. */ }
    const output = (snapshot: Snapshot, status: 'ok' | 'stale') => ({ ...base,
      range: { from: snapshot.from, to: snapshot.to, days: config.days },
      github: { ...source, status, updatedAt: new Date(snapshot.fetchedAt).toISOString(), daily: snapshot.daily, stats: activityStats(snapshot.daily) } });
    const saved = cached?.snapshot;
    if (saved && saved.to === dates.at(-1) && time - saved.fetchedAt < FRESH) return output(saved, 'ok');
    const fallback = () => saved && time - saved.fetchedAt <= STALE ? output(saved, 'stale') : unavailable('unavailable');
    if (cached && time - cached.attemptedAt < RETRY) return fallback();
    const write = async (value: Cache) => {
      try { await this.env.MEDIA.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } }); }
      catch { /* The live response remains valid when optional cache storage fails. */ }
    };
    try {
      // A one-day margin covers every IANA offset; the local-date filter below
      // selects the exact calendar interval without approximating DST offsets.
      const since = new Date(Date.parse(dates[0] + 'T00:00:00Z') - DAY).toISOString();
      const commits = await this.github.listCommitDates(since, now.toISOString());
      const counts = new Map(dates.map(date => [date, 0]));
      for (const commit of commits) {
        const date = calendarDate(new Date(commit.date), config.timezone);
        if (counts.has(date)) counts.set(date, counts.get(date)! + 1);
      }
      const snapshot = { from: dates[0], to: dates.at(-1)!, fetchedAt: time, daily: dates.map(date => ({ date, count: counts.get(date)! })) };
      await write({ version: 1, attemptedAt: time, snapshot });
      return output(snapshot, 'ok');
    } catch {
      await write({ version: 1, attemptedAt: time, snapshot: saved && time - saved.fetchedAt <= STALE ? saved : null });
      return fallback();
    }
  }
}
