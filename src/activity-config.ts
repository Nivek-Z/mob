import { ApiError, object } from './http';

export interface ActivityConfig {
  enabled: boolean; title: string; days: number; timezone: string;
  github: { enabled: boolean; title: string };
}
export function activityConfig(value: unknown): ActivityConfig {
  if (value === undefined) return { enabled: false, title: '代码足迹', days: 365, timezone: 'Asia/Hong_Kong', github: { enabled: true, title: 'GitHub 提交活动' } };
  const input = object(value), github = object(input.github);
  const title = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 100;
  if (Object.keys(input).some(key => !['enabled', 'title', 'days', 'timezone', 'github'].includes(key))
    || Object.keys(github).some(key => !['enabled', 'title'].includes(key))
    || typeof input.enabled !== 'boolean' || typeof github.enabled !== 'boolean' || !title(input.title) || !title(github.title)
    || !Number.isInteger(input.days) || Number(input.days) < 30 || Number(input.days) > 366
    || typeof input.timezone !== 'string' || input.timezone.length > 100) {
    throw new ApiError(422, 'INVALID_ACTIVITY', 'Supply activity enabled/title/days/timezone and github enabled/title. Days must be 30–366.');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format(); }
  catch { throw new ApiError(422, 'INVALID_ACTIVITY', 'Use a valid IANA time zone for activity.'); }
  return { enabled: input.enabled, title: input.title, days: input.days as number, timezone: input.timezone, github: { enabled: github.enabled, title: github.title } };
}
