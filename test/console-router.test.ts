import { describe, expect, test } from 'bun:test';
import {
  isNavLinkActive,
  matchRoutes,
  normalizeBasename,
  resolveTo,
  stripBasename,
  type RouteDef,
} from '../src/console/client/router.js';

const r = (path: string | undefined, children: RouteDef[] = [], extra: Partial<RouteDef> = {}): RouteDef => ({
  path,
  element: path ?? 'layout',
  children,
  ...extra,
});
const index = (element = 'index'): RouteDef => ({ index: true, element, children: [] });

// mirrors ConsoleApp.tsx's table, with one plugin route set
const consoleRoutes: RouteDef[] = [
  r('/setup'),
  r('/login'),
  r(undefined, [
    r('workspace/:workspaceId/*'),
    r('profile'),
    r(undefined, [index(), r('settings'), r('settings/:domain'), r('workflows'), r('workflows/:workflowId'), r(':model/*')]),
  ]),
  r('*'),
];

function leaf(pathname: string, routes = consoleRoutes, base?: string, params?: Record<string, string>) {
  const m = matchRoutes(routes, pathname, base, params);
  if (!m) return null;
  return { element: m[m.length - 1]!.route.element, params: m[0]!.params, base: m[m.length - 1]!.pathnameBase, depth: m.length };
}

describe('matchRoutes', () => {
  test('index route under nested pathless layouts', () => {
    expect(leaf('/')).toEqual({ element: 'index', params: {}, base: '/', depth: 3 });
  });

  test('top-level static routes', () => {
    expect(leaf('/login')?.element).toBe('/login');
    expect(leaf('/setup')?.element).toBe('/setup');
  });

  test('static path declared before a dynamic sibling wins', () => {
    expect(leaf('/settings')?.element).toBe('settings');
    expect(leaf('/settings/shop')).toMatchObject({ element: 'settings/:domain', params: { domain: 'shop' } });
    expect(leaf('/workflows')?.element).toBe('workflows');
    expect(leaf('/workflows/abc')).toMatchObject({ element: 'workflows/:workflowId', params: { workflowId: 'abc' } });
  });

  test('splat route captures the remainder and exposes its base', () => {
    expect(leaf('/customers')).toMatchObject({ element: ':model/*', params: { model: 'customers', '*': '' }, base: '/customers' });
    expect(leaf('/customers/42')).toMatchObject({ params: { model: 'customers', '*': '42' }, base: '/customers' });
    expect(leaf('/workspace/w1/orders/new')).toMatchObject({
      element: 'workspace/:workspaceId/*',
      params: { workspaceId: 'w1', '*': 'orders/new' },
      base: '/workspace/w1',
    });
  });

  test('every match in a branch shares the full params', () => {
    const m = matchRoutes(consoleRoutes, '/settings/shop')!;
    expect(m.map((x) => x.params)).toEqual([{ domain: 'shop' }, { domain: 'shop' }, { domain: 'shop' }]);
  });

  test('descendant routes match below the parent base and inherit params', () => {
    const descendants = [r('new'), r(':id')];
    expect(leaf('/customers/new', descendants, '/customers', { model: 'customers' })).toMatchObject({
      element: 'new',
      params: { model: 'customers' },
      base: '/customers/new',
    });
    expect(leaf('/customers/42', descendants, '/customers', { model: 'customers' })?.params).toEqual({ model: 'customers', id: '42' });
    expect(leaf('/customers', descendants, '/customers', { model: 'customers' })).toBeNull();
    expect(leaf('/other/42', descendants, '/customers')).toBeNull();
  });

  test('decodes params and compares static segments case-insensitively', () => {
    expect(leaf('/Settings')?.element).toBe('settings');
    expect(leaf('/settings/a%20b')?.params).toEqual({ domain: 'a b' });
  });

  test('a path route with children still matches alone when nothing below does', () => {
    const routes = [r('parent', [r('child')])];
    expect(leaf('/parent', routes)).toMatchObject({ element: 'parent', depth: 1 });
    expect(leaf('/parent/child', routes)).toMatchObject({ element: 'child', depth: 2 });
    expect(leaf('/parent/other', routes)).toBeNull();
  });

  test('no match without a catch-all', () => {
    expect(matchRoutes([r('a')], '/b')).toBeNull();
  });
});

describe('basename handling', () => {
  test('normalizeBasename', () => {
    expect(normalizeBasename('/')).toBe('');
    expect(normalizeBasename('')).toBe('');
    expect(normalizeBasename('/console/')).toBe('/console');
    expect(normalizeBasename('console')).toBe('/console');
  });

  test('stripBasename', () => {
    expect(stripBasename('/console', '/console')).toBe('/');
    expect(stripBasename('/console/customers', '/console')).toBe('/customers');
    expect(stripBasename('/consoles', '/console')).toBeNull();
    expect(stripBasename('/anything', '')).toBe('/anything');
  });
});

describe('resolveTo', () => {
  test('absolute, relative, and dot segments', () => {
    expect(resolveTo('/profile', '/customers')).toEqual({ pathname: '/profile', search: '', hash: '' });
    expect(resolveTo('new?x=1#h', '/customers')).toEqual({ pathname: '/customers/new', search: '?x=1', hash: '#h' });
    expect(resolveTo('../orders', '/customers/42')).toEqual({ pathname: '/customers/orders', search: '', hash: '' });
  });

  test('object form, with and without a pathname', () => {
    expect(resolveTo({ pathname: '/customers/new', search: '?page=2' }, '/')).toEqual({ pathname: '/customers/new', search: '?page=2', hash: '' });
    expect(resolveTo({ search: 'q=a' }, '/customers')).toEqual({ pathname: '/customers', search: '?q=a', hash: '' });
  });
});

describe('isNavLinkActive', () => {
  test('matches react-router NavLink semantics', () => {
    expect(isNavLinkActive('/customers', '/customers')).toBe(true);
    expect(isNavLinkActive('/customers/42', '/customers')).toBe(true);
    expect(isNavLinkActive('/customersx', '/customers')).toBe(false);
    expect(isNavLinkActive('/customers/42', '/customers', true)).toBe(false);
    expect(isNavLinkActive('/anything', '/')).toBe(true);
    expect(isNavLinkActive('/anything', '/', true)).toBe(false);
  });
});
