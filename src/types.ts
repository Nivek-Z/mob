export interface Env {
  ASSETS: Fetcher;
  MEDIA: R2Bucket;
  MUTATIONS: DurableObjectNamespace;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  POSTS_DIRECTORY: string;
  GITHUB_TOKEN?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ADMIN_EMAILS: string;
  SITE_ORIGIN: string;
  APP_ENV?: string;
  DEV_AUTH_TOKEN?: string;
  INDEX_CACHE_SECONDS?: string;
  MAX_MEDIA_BYTES?: string;
}
export interface Identity { email: string; subject: string; }
export type PostStatus = 'draft' | 'published';
export interface Post {
  slug: string; sha: string; title: string; markdown: string;
  description: string; tags: string[]; status: PostStatus;
  createdAt: string; updatedAt: string; publishedAt: string | null;
  cover: string | null; mediaIds: string[];
}
export interface SavePostInput {
  sha: string | null; title: string; markdown: string; status: PostStatus;
  description?: string; tags?: string[]; cover?: string | null; mediaIds?: string[];
}
export interface PostMutation { post: Post; commitSha: string; }
export interface MediaRecord {
  id: string; key: string; filename: string; contentType: string;
  size: number; owner: string; createdAt: string; url: string;
}
export interface UploadSession {
  id: string; key: string; filename: string; contentType: string; size: number;
  owner: string; createdAt: string; expiresAt: string;
  mode: 'single' | 'multipart'; partSize: number; partCount: number;
  uploadId?: string; url: string;
}
