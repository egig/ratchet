/**
 * A minimal, hand-rolled replacement for the subset of Hono this framework used: method-based
 * routing with `:param`/`*` segments, `app.route(prefix, subApp)` composition, and a per-app error
 * handler — built directly on the Fetch API's `Request`/`Response` (Bun.serve's own contract), the
 * same "no framework, just the platform" style `react-router-bun` uses for its own `Bun.serve`
 * handler. Route-matching is a linear scan in registration order (first structural match wins) —
 * not a trie — which is deliberate: several routers in this codebase (see
 * `router/create-router.ts`'s `POST /:model/:field/upload` vs `POST /:model/:id/:operation`) are
 * already written to rely on registration order to disambiguate two same-shaped dynamic routes,
 * exactly the behavior this reproduces.
 */

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type Handler = (c: Ctx) => Response | Promise<Response>;
export type ErrorHandler = (err: unknown, c: Ctx) => Response | Promise<Response>;

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/** `null` = no match; otherwise the bound `:param` values. A trailing `*` segment matches the
 * rest of the path (zero or more segments) and stops matching immediately, mirroring Hono's own
 * wildcard semantics (`console/router.ts`'s `/assets/*` and `/*`). */
function matchSegments(pattern: string[], pathSegments: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  let pathIndex = 0;
  for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
    const segment = pattern[patternIndex]!;
    if (segment === '*') return params;
    if (pathIndex >= pathSegments.length) return null;
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(pathSegments[pathIndex]!);
    } else if (segment !== pathSegments[pathIndex]) {
      return null;
    }
    pathIndex++;
  }
  return pathIndex === pathSegments.length ? params : null;
}

/** Normalizes an `app.route()` mount prefix (`'/'`, `'/api'`, `'/api/auth'`, never trailing-slashed
 * except the root itself) and, given a full request path, strips it back off — returning `null`
 * when the path isn't actually under this prefix. Mounting at `'/'` consumes nothing (the whole
 * path is still handed to the sub-app), matching how the web app's catch-all router and a root
 * `consolePath` both expect to see the full path space. */
function stripPrefix(path: string, prefix: string): string | null {
  if (prefix === '/') return path;
  if (path === prefix) return '/';
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return null;
}

export class Ctx {
  readonly req: {
    readonly raw: Request;
    readonly url: string;
    readonly path: string;
    readonly method: string;
    param(name: string): string;
    json(): Promise<unknown>;
    parseBody(): Promise<Record<string, FormDataEntryValue>>;
  };

  private readonly pendingHeaders: [string, string][] = [];

  constructor(request: Request, params: Record<string, string>) {
    const url = new URL(request.url);
    this.req = {
      raw: request,
      url: request.url,
      path: url.pathname,
      method: request.method,
      param: (name) => params[name]!,
      json: () => request.json(),
      parseBody: async () => {
        const form = await request.formData();
        const out: Record<string, FormDataEntryValue> = {};
        for (const [key, value] of form.entries()) out[key] = value;
        return out;
      },
    };
  }

  /** Queues a response header (e.g. `Set-Cookie`) to be merged into whatever `Response` this
   * handler eventually produces via `json`/`text`/`html` — mirrors Hono's `c.header(name, value,
   * { append: true })`, which `hono/cookie`'s `setCookie`/`deleteCookie` built on. A handler that
   * builds its own `Response` directly (streaming, file-serving) never calls `json`/`text`/`html`,
   * so it never needs this — nothing here queues into that path. */
  appendHeader(name: string, value: string): void {
    this.pendingHeaders.push([name, value]);
  }

  private withPendingHeaders(response: Response): Response {
    for (const [name, value] of this.pendingHeaders) response.headers.append(name, value);
    return response;
  }

  json(body: unknown, status = 200): Response {
    return this.withPendingHeaders(Response.json(body, { status }));
  }

  text(body: string, status = 200): Response {
    return this.withPendingHeaders(new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  }

  html(body: string, status = 200): Response {
    return this.withPendingHeaders(new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  }

  notFound(): Response {
    return this.withPendingHeaders(new Response('404 Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } }));
  }
}

type Entry =
  | { kind: 'route'; method: Method; pattern: string[]; handler: Handler }
  | { kind: 'mount'; prefix: string; app: App };

/** Drop-in replacement for the handful of `Hono` features this framework's routers actually use.
 * Composes exactly like Hono's `app.route(prefix, subApp)` did (see `cli/commands/serve.ts`), and
 * exposes the same `.fetch`/`.request()` shape so `Bun.serve({ fetch: app.fetch })` and this
 * package's `*.test.ts` suites (which call `app.request(path, init)` directly, Hono's own
 * test-client convenience) keep working unchanged. */
export class App {
  private readonly entries: Entry[] = [];
  private errorHandler?: ErrorHandler;

  get(path: string, handler: Handler): void {
    this.entries.push({ kind: 'route', method: 'GET', pattern: splitPath(path), handler });
  }

  post(path: string, handler: Handler): void {
    this.entries.push({ kind: 'route', method: 'POST', pattern: splitPath(path), handler });
  }

  put(path: string, handler: Handler): void {
    this.entries.push({ kind: 'route', method: 'PUT', pattern: splitPath(path), handler });
  }

  patch(path: string, handler: Handler): void {
    this.entries.push({ kind: 'route', method: 'PATCH', pattern: splitPath(path), handler });
  }

  delete(path: string, handler: Handler): void {
    this.entries.push({ kind: 'route', method: 'DELETE', pattern: splitPath(path), handler });
  }

  route(prefix: string, app: App): void {
    const normalized = prefix === '/' ? '/' : prefix.replace(/\/+$/, '');
    this.entries.push({ kind: 'mount', prefix: normalized, app });
  }

  onError(handler: ErrorHandler): void {
    this.errorHandler = handler;
  }

  private async dispatch(request: Request, matchPath: string): Promise<Response> {
    const pathSegments = splitPath(matchPath);
    for (const entry of this.entries) {
      if (entry.kind === 'mount') {
        const stripped = stripPrefix(matchPath, entry.prefix);
        if (stripped === null) continue;
        return entry.app.dispatch(request, stripped);
      }
      if (entry.method !== request.method) continue;
      const params = matchSegments(entry.pattern, pathSegments);
      if (!params) continue;
      const ctx = new Ctx(request, params);
      try {
        return await entry.handler(ctx);
      } catch (err) {
        if (this.errorHandler) return await this.errorHandler(err, ctx);
        console.error(err);
        return new Response('Internal Server Error', { status: 500 });
      }
    }
    return new Ctx(request, {}).notFound();
  }

  /** Bound (not a prototype method) so it survives being handed to `Bun.serve({ fetch: app.fetch
   * })` or `serve({ fetch: app.fetch })` unattached to `this` — same calling convention Hono's own
   * `app.fetch` supported. */
  fetch = (request: Request): Promise<Response> => {
    return this.dispatch(request, new URL(request.url).pathname);
  };

  /** Test-only convenience matching Hono's `app.request(path, init)` — builds a `Request` against
   * a fixed local origin and runs it through `fetch`. Used throughout this package's `test/*.ts`
   * suites. */
  request = (input: string | Request, init?: RequestInit): Promise<Response> => {
    const request = typeof input === 'string' ? new Request(new URL(input, 'http://localhost'), init) : input;
    return this.fetch(request);
  };
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  path?: string;
  maxAge?: number;
}

function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}

/** Replacement for `hono/cookie`'s `setCookie`/`deleteCookie` — queues a `Set-Cookie` header onto
 * `c` (see `Ctx.appendHeader`) rather than writing to a response object directly, since the
 * response doesn't exist yet at the point `auth/router.ts` calls this (it's built afterwards by
 * `c.json(...)`). */
export function setCookie(c: Ctx, name: string, value: string, options: CookieOptions = {}): void {
  c.appendHeader('Set-Cookie', serializeCookie(name, value, options));
}

export function deleteCookie(c: Ctx, name: string, options: { path?: string } = {}): void {
  c.appendHeader('Set-Cookie', serializeCookie(name, '', { path: options.path, maxAge: 0 }));
}
