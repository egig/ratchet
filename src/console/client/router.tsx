import {
  Children,
  createContext,
  Fragment,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

/**
 * The console SPA's client-side router — a deliberately small replacement for react-router's
 * declarative mode, covering exactly what the console (and plugin console pages) use:
 * `<Router basename>`, `<Routes>`/`<Route>` (nested, pathless layout, `index`, `:param`, trailing
 * `*` splat, descendant `<Routes>` under a splat), `<Outlet>`, `<Link>`, `<NavLink>`,
 * `<Navigate>`, `useNavigate`, `useParams`, `useLocation`, `useSearchParams`.
 *
 * Matching differs from react-router in one way: routes are tried **in declaration order, first
 * match wins** (the same rule as the server's `http-app.ts`), not ranked by specificity. Declare a
 * static path before a dynamic sibling it would otherwise lose to (`settings` before `:model/*`).
 * Static segments compare case-insensitively, as react-router's do by default.
 *
 * The public site (`src/web/`) still uses react-router's data mode; this module is console-only.
 */

export interface Location {
  /** without the router's `basename` */
  pathname: string;
  /** `''` or `'?…'` */
  search: string;
  /** `''` or `'#…'` */
  hash: string;
  state: unknown;
  key: string;
}

export type To = string | { pathname?: string; search?: string; hash?: string };

export interface NavigateOptions {
  replace?: boolean;
  state?: unknown;
}

export interface NavigateFunction {
  (to: To, options?: NavigateOptions): void;
  /** history delta, e.g. `-1` for back */
  (delta: number): void;
}

export type Params = Record<string, string | undefined>;

// ---------------------------------------------------------------------------------------------
// Pure path helpers (exported for tests)

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

function joinSegments(segments: readonly string[]): string {
  return '/' + segments.join('/');
}

/** `'/'` and `''` → `''`; otherwise a leading slash and no trailing one. */
export function normalizeBasename(basename: string): string {
  const trimmed = basename.replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : '/' + trimmed;
}

/** The router-relative pathname, or `null` when `pathname` is outside `basename`. */
export function stripBasename(pathname: string, basename: string): string | null {
  if (!basename) return pathname || '/';
  const lowerPath = pathname.toLowerCase();
  const lowerBase = basename.toLowerCase();
  if (lowerPath === lowerBase) return '/';
  if (!lowerPath.startsWith(lowerBase + '/')) return null;
  return pathname.slice(basename.length);
}

function parsePath(path: string): { pathname: string; search: string; hash: string } {
  let rest = path;
  let hash = '';
  let search = '';
  const hashAt = rest.indexOf('#');
  if (hashAt >= 0) {
    hash = rest.slice(hashAt);
    rest = rest.slice(0, hashAt);
  }
  const searchAt = rest.indexOf('?');
  if (searchAt >= 0) {
    search = rest.slice(searchAt);
    rest = rest.slice(0, searchAt);
  }
  return { pathname: rest, search, hash };
}

/** Resolves `to` against `from` (a router-relative pathname): absolute paths pass through,
 * relative ones are joined onto `from`, with `.` and `..` segments applied. A `to` object without
 * a `pathname` stays on `from`. */
export function resolveTo(to: To, from: string): { pathname: string; search: string; hash: string } {
  const parts = typeof to === 'string' ? parsePath(to) : { pathname: to.pathname ?? '', search: to.search ?? '', hash: to.hash ?? '' };
  const search = parts.search && !parts.search.startsWith('?') ? '?' + parts.search : parts.search;
  const hash = parts.hash && !parts.hash.startsWith('#') ? '#' + parts.hash : parts.hash;
  if (!parts.pathname) return { pathname: from, search, hash };
  const segments = parts.pathname.startsWith('/') ? [] : splitPath(from);
  for (const seg of splitPath(parts.pathname)) {
    if (seg === '..') segments.pop();
    else if (seg !== '.') segments.push(seg);
  }
  return { pathname: joinSegments(segments), search, hash };
}

/** react-router's `NavLink` rule: active on an exact match, or (without `end`) on any path below
 * `to` — so `to="/"` without `end` is active everywhere. Case-insensitive. */
export function isNavLinkActive(locationPathname: string, toPathname: string, end = false): boolean {
  const loc = locationPathname.toLowerCase();
  const to = toPathname.toLowerCase();
  if (loc === to) return true;
  if (end) return false;
  const boundary = to.endsWith('/') ? to.length - 1 : to.length;
  return loc.startsWith(to) && loc.charAt(boundary) === '/';
}

export interface RouteDef {
  path?: string;
  index?: boolean;
  element?: ReactNode;
  children: RouteDef[];
}

export interface RouteMatch {
  route: RouteDef;
  /** every param of the whole matched branch (the same object on each match, as in react-router) */
  params: Params;
  /** router-relative pathname this route consumed, excluding a splat — what descendant
   * `<Routes>` and relative links resolve against */
  pathnameBase: string;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function matchBranch(
  routes: readonly RouteDef[],
  remaining: readonly string[],
  consumed: readonly string[],
  params: Params,
): RouteMatch[] | null {
  for (const route of routes) {
    if (route.index) {
      if (remaining.length === 0) return [{ route, params, pathnameBase: joinSegments(consumed) }];
      continue;
    }

    if (route.path === undefined) {
      // pathless layout route: transparent to matching, matches iff a child does
      const child = matchBranch(route.children, remaining, consumed, params);
      if (child) return [{ route, params, pathnameBase: joinSegments(consumed) }, ...child];
      continue;
    }

    const pattern = splitPath(route.path);
    const local: Params = {};
    let used = 0;
    let splat = false;
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const seg = pattern[i]!;
      if (seg === '*' && i === pattern.length - 1) {
        local['*'] = remaining.slice(i).map(safeDecode).join('/');
        splat = true;
        break;
      }
      const actual = remaining[i];
      if (actual === undefined) {
        ok = false;
        break;
      }
      if (seg.startsWith(':')) local[seg.slice(1)] = safeDecode(actual);
      else if (seg.toLowerCase() !== actual.toLowerCase()) {
        ok = false;
        break;
      }
      used = i + 1;
    }
    if (!ok) continue;

    const nextConsumed = [...consumed, ...remaining.slice(0, used)];
    const rest = remaining.slice(used);
    const merged = { ...params, ...local };
    const self: RouteMatch = { route, params: merged, pathnameBase: joinSegments(nextConsumed) };

    if (splat) return [self];
    if (route.children.length > 0) {
      const child = matchBranch(route.children, rest, nextConsumed, merged);
      if (child) return [self, ...child];
    }
    if (rest.length === 0) return [self];
  }
  return null;
}

/** Matches `pathname` (router-relative) against `routes`, below an already-consumed
 * `basePathname` (descendant `<Routes>`), inheriting `parentParams`. Returns the matched branch,
 * outermost first, with one shared `params` object, or `null`. */
export function matchRoutes(
  routes: readonly RouteDef[],
  pathname: string,
  basePathname = '/',
  parentParams: Params = {},
): RouteMatch[] | null {
  const all = splitPath(pathname);
  const base = splitPath(basePathname);
  const below = all.slice(0, base.length).every((seg, i) => seg.toLowerCase() === base[i]!.toLowerCase());
  if (!below || all.length < base.length) return null;
  const matches = matchBranch(routes, all.slice(base.length), base, { ...parentParams });
  if (!matches) return null;
  const params = matches[matches.length - 1]!.params;
  return matches.map((m) => ({ ...m, params }));
}

// ---------------------------------------------------------------------------------------------
// React layer

interface RouterContextValue {
  basename: string;
  /** `null` when the browser URL is outside `basename` */
  location: Location | null;
  navigate: NavigateFunction;
  /** the latest location, updated synchronously on navigate — read by `useSearchParams`'s
   * updater so two calls in one tick compose instead of the second clobbering the first */
  locationRef: { current: Location | null };
}

interface RouteContextValue {
  params: Params;
  pathnameBase: string;
  outlet: ReactNode;
}

const RouterContext = createContext<RouterContextValue | null>(null);
const RouteContext = createContext<RouteContextValue>({ params: {}, pathnameBase: '/', outlet: null });

interface HistoryState {
  usr?: unknown;
  key?: string;
}

function createKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function readLocation(basename: string): Location | null {
  const pathname = stripBasename(window.location.pathname, basename);
  if (pathname === null) return null;
  const state = (window.history.state ?? {}) as HistoryState;
  return {
    pathname,
    search: window.location.search,
    hash: window.location.hash,
    state: state.usr ?? null,
    key: state.key ?? 'default',
  };
}

function useRouterContext(hook: string): RouterContextValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error(`${hook} must be used inside the console's <Router>`);
  return ctx;
}

function createHref(basename: string, path: { pathname: string; search: string; hash: string }): string {
  const pathname = path.pathname === '/' ? basename || '/' : basename + path.pathname;
  return pathname + path.search + path.hash;
}

/** The console's browser-history router. `basename` is the console mount path (`'/'` allowed). */
export function Router({ basename: rawBasename = '', children }: { basename?: string; children?: ReactNode }) {
  const basename = normalizeBasename(rawBasename);
  const [location, setLocation] = useState(() => readLocation(basename));
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    const onPop = () => {
      const next = readLocation(basename);
      locationRef.current = next;
      setLocation(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [basename]);

  const navigate = useCallback<NavigateFunction>(
    ((to: To | number, options?: NavigateOptions) => {
      if (typeof to === 'number') {
        window.history.go(to);
        return;
      }
      const from = locationRef.current?.pathname ?? '/';
      const path = resolveTo(to, from);
      const key = createKey();
      const state: HistoryState = { usr: options?.state, key };
      const href = createHref(basename, path);
      if (options?.replace) window.history.replaceState(state, '', href);
      else window.history.pushState(state, '', href);
      const next: Location = { ...path, state: options?.state ?? null, key };
      locationRef.current = next;
      setLocation(next);
    }) as NavigateFunction,
    [basename],
  );

  const value = useMemo<RouterContextValue>(() => ({ basename, location, navigate, locationRef }), [basename, location, navigate]);
  return <RouterContext.Provider value={value}>{children}</RouterContext.Provider>;
}

export interface RouteProps {
  path?: string;
  index?: boolean;
  element?: ReactNode;
  children?: ReactNode;
}

/** Configuration only — `<Routes>` reads its props and never renders it. */
export function Route(_props: RouteProps): ReactElement | null {
  return null;
}

function createRoutes(children: ReactNode): RouteDef[] {
  const routes: RouteDef[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) {
      routes.push(...createRoutes((child.props as { children?: ReactNode }).children));
      return;
    }
    if (child.type !== Route) throw new Error('<Routes> children must be <Route> or <Fragment> elements');
    const props = child.props as RouteProps;
    routes.push({ path: props.path, index: props.index, element: props.element, children: createRoutes(props.children) });
  });
  return routes;
}

/** Renders the first matching branch of its `<Route>` children. Nested under a splat route it
 * matches the remainder of the URL below that route. Renders nothing when no route matches. */
export function Routes({ children }: { children?: ReactNode }) {
  const { location } = useRouterContext('<Routes>');
  const parent = useContext(RouteContext);
  const routes = createRoutes(children);
  if (!location) return null;
  const matches = matchRoutes(routes, location.pathname, parent.pathnameBase, parent.params);
  if (!matches) return null;
  return matches.reduceRight<ReactNode>(
    (outlet, match) => (
      <RouteContext.Provider value={{ params: match.params, pathnameBase: match.pathnameBase, outlet }}>
        {match.route.element ?? outlet}
      </RouteContext.Provider>
    ),
    null,
  );
}

/** The matched child route's element, inside a layout route's element. */
export function Outlet() {
  return <>{useContext(RouteContext).outlet}</>;
}

export function useNavigate(): NavigateFunction {
  const { navigate } = useRouterContext('useNavigate()');
  const { pathnameBase } = useContext(RouteContext);
  // relative `to` resolves against the calling route, as in react-router
  return useCallback<NavigateFunction>(
    ((to: To | number, options?: NavigateOptions) => {
      if (typeof to === 'number') navigate(to);
      else navigate(resolveTo(to, pathnameBase), options);
    }) as NavigateFunction,
    [navigate, pathnameBase],
  );
}

export function useLocation(): Location {
  const { location } = useRouterContext('useLocation()');
  return location ?? { pathname: '/', search: '', hash: '', state: null, key: 'default' };
}

/** Every param of the matched branch; `'*'` holds a splat's remainder. */
export function useParams<T extends Params = Params>(): Readonly<Partial<T>> {
  return useContext(RouteContext).params as Partial<T>;
}

export type SetSearchParams = (
  next: URLSearchParams | Record<string, string> | ((prev: URLSearchParams) => URLSearchParams),
  options?: NavigateOptions,
) => void;

export function useSearchParams(): [URLSearchParams, SetSearchParams] {
  const { location, navigate, locationRef } = useRouterContext('useSearchParams()');
  const search = location?.search ?? '';
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const setParams = useCallback<SetSearchParams>(
    (next, options) => {
      const current = locationRef.current;
      const resolved =
        typeof next === 'function' ? next(new URLSearchParams(current?.search ?? '')) : new URLSearchParams(next);
      const query = resolved.toString();
      navigate({ pathname: current?.pathname ?? '/', search: query ? '?' + query : '', hash: current?.hash ?? '' }, options);
    },
    [navigate, locationRef],
  );
  return [params, setParams];
}

function isPlainLeftClick(event: MouseEvent<HTMLAnchorElement>, target: string | undefined): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    (!target || target === '_self') &&
    !(event.metaKey || event.altKey || event.ctrlKey || event.shiftKey)
  );
}

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  to: To;
  replace?: boolean;
  state?: unknown;
  /** skip client-side navigation and let the browser load the URL */
  reloadDocument?: boolean;
}

function useLinkHandlers(to: To, { replace, state, reloadDocument, target, onClick }: Pick<LinkProps, 'replace' | 'state' | 'reloadDocument' | 'target' | 'onClick'>) {
  const { basename } = useRouterContext('<Link>');
  const { pathnameBase } = useContext(RouteContext);
  const navigate = useNavigate();
  const path = resolveTo(to, pathnameBase);
  const href = createHref(basename, path);
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (reloadDocument || !isPlainLeftClick(event, target)) return;
    event.preventDefault();
    navigate(path, { replace, state });
  };
  return { path, href, handleClick };
}

export function Link({ to, replace, state, reloadDocument, onClick, target, ...rest }: LinkProps) {
  const { href, handleClick } = useLinkHandlers(to, { replace, state, reloadDocument, target, onClick });
  return <a {...rest} href={href} target={target} onClick={handleClick} />;
}

export interface NavLinkProps extends Omit<LinkProps, 'className' | 'children'> {
  /** only active on an exact match, not on paths below `to` */
  end?: boolean;
  className?: string | ((state: { isActive: boolean }) => string | undefined);
  children?: ReactNode | ((state: { isActive: boolean }) => ReactNode);
}

/** A `<Link>` that knows whether it's active (sets `aria-current="page"` when it is). */
export function NavLink({ to, end, className, children, replace, state, reloadDocument, onClick, target, ...rest }: NavLinkProps) {
  const { path, href, handleClick } = useLinkHandlers(to, { replace, state, reloadDocument, target, onClick });
  const location = useLocation();
  const isActive = isNavLinkActive(location.pathname, path.pathname, end);
  return (
    <a
      {...rest}
      href={href}
      target={target}
      onClick={handleClick}
      aria-current={isActive ? 'page' : undefined}
      className={typeof className === 'function' ? className({ isActive }) : className}
    >
      {typeof children === 'function' ? children({ isActive }) : children}
    </a>
  );
}

/** Navigates once, after mount (an effect, never during render). */
export function Navigate({ to, replace, state }: { to: To } & NavigateOptions) {
  const navigate = useNavigate();
  const target = JSON.stringify(typeof to === 'string' ? to : [to.pathname, to.search, to.hash]);
  useEffect(() => {
    navigate(to, { replace, state });
    // re-run only when the destination changes, not on every render's new `to` object
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, target, replace]);
  return null;
}
