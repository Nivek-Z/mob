import { createApp } from './index';
import type { Env } from './types';

export type MutationHandler = (request: Request, env: Env, state: DurableObjectState) => Promise<Response>;

/** One Durable Object instance owns the queue for GitHub article mutations and media deletion. */
export class BlogMutations {
  private tail: Promise<void> = Promise.resolve();
  private readonly handler: MutationHandler;

  constructor(private readonly state: DurableObjectState, private readonly env: Env, handler?: MutationHandler) {
    if (handler) this.handler = handler;
    else {
      const app = createApp({}, { coordinateMutations: false });
      this.handler = (request, environment, context) => app.fetch(request, environment, context as unknown as ExecutionContext);
    }
  }

  fetch(request: Request): Promise<Response> {
    const result = this.tail.then(() => this.handler(request, this.env, this.state));
    // Recover the queue even when a handler throws, so later writes are never stranded.
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
