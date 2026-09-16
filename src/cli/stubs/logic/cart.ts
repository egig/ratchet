import { sql } from 'drizzle-orm';
import type { AnyDb } from '@egig/ratchet/core';

/**
 * A guest shopping cart, held entirely in one cookie — no `Cart` model, no session required. The
 * cookie only ever stores `{ productId, quantity }` pairs; every price, name, and stock check is
 * re-derived from the live `products` row at render time (routes/cart.tsx) and again at
 * routes/checkout.tsx's transaction, so a tampered cookie can misstate what a visitor *wants*, never
 * what they're actually charged.
 */
export interface CartLine {
  productId: string;
  quantity: number;
}

export const CART_COOKIE_NAME = 'ratchet_cart';
const MAX_LINE_QUANTITY = 99;
const MAX_LINES = 50;
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function clampQuantity(value: number): number {
  return Math.min(Math.max(Math.trunc(value) || 0, 0), MAX_LINE_QUANTITY);
}

/** Reads and validates the cart cookie off an incoming request — never throws; any malformed or
 * tampered value just reads back as an empty cart. */
export function readCart(request: Request): CartLine[] {
  const header = request.headers.get('cookie');
  if (!header) return [];
  const match = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CART_COOKIE_NAME}=`));
  if (!match) return [];

  try {
    const json = decodeURIComponent(match.slice(CART_COOKIE_NAME.length + 1));
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const lines: CartLine[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const productId = (entry as Record<string, unknown>).productId;
      const quantity = clampQuantity(Number((entry as Record<string, unknown>).quantity));
      if (typeof productId === 'string' && productId.length > 0 && quantity > 0) {
        lines.push({ productId, quantity });
      }
    }
    return lines.slice(0, MAX_LINES);
  } catch {
    return [];
  }
}

/** `Set-Cookie` header value that persists `lines` — httpOnly (a cart is never read by client JS
 * here), `SameSite=Lax` (survives a normal top-level navigation/POST, blocks cross-site reads). */
export function cartCookieHeader(lines: CartLine[]): string {
  const value = encodeURIComponent(JSON.stringify(lines.slice(0, MAX_LINES)));
  return `${CART_COOKIE_NAME}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax; HttpOnly`;
}

export function clearCartCookieHeader(): string {
  return `${CART_COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`;
}

export function addLine(lines: CartLine[], productId: string, quantity: number): CartLine[] {
  const qty = clampQuantity(quantity) || 1;
  const existing = lines.find((l) => l.productId === productId);
  if (existing) {
    return lines.map((l) => (l.productId === productId ? { ...l, quantity: clampQuantity(l.quantity + qty) } : l));
  }
  if (lines.length >= MAX_LINES) return lines;
  return [...lines, { productId, quantity: qty }];
}

/** `quantity <= 0` removes the line entirely — the same gesture a user expresses by clearing the
 * quantity input to 0. */
export function setLineQuantity(lines: CartLine[], productId: string, quantity: number): CartLine[] {
  const qty = clampQuantity(quantity);
  if (qty <= 0) return lines.filter((l) => l.productId !== productId);
  return lines.map((l) => (l.productId === productId ? { ...l, quantity: qty } : l));
}

export function removeLine(lines: CartLine[], productId: string): CartLine[] {
  return lines.filter((l) => l.productId !== productId);
}

export function cartItemCount(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity, 0);
}

export interface CartProductLine {
  id: string;
  name: string;
  slug: string;
  price: string;
  stock: number;
  imageLabel: string | null;
  quantity: number;
}

/** Joins cart lines against the live `products` table — shared by routes/cart.tsx (display) and
 * routes/checkout.tsx (both the order summary and, run against its transaction handle, the
 * authoritative snapshot a checkout is priced from). A line whose product was deleted or
 * deactivated since it was added is silently dropped; a line asking for more than is in stock is
 * clamped down to what's available — the same "never trust the cookie" rule `readCart` follows. */
export async function hydrateCartLines(db: AnyDb, lines: CartLine[]): Promise<CartProductLine[]> {
  if (lines.length === 0) return [];
  const ids = sql.join(
    lines.map((l) => sql`${l.productId}`),
    sql`, `,
  );
  const rows = (await db.execute(
    sql`select id, name, slug, price, stock, image_label as "imageLabel" from products
        where id in (${ids}) and status = 'active' and deleted_at is null`,
  )) as unknown as Omit<CartProductLine, 'quantity'>[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const result: CartProductLine[] = [];
  for (const line of lines) {
    const product = byId.get(line.productId);
    if (!product) continue;
    result.push({ ...product, quantity: Math.min(line.quantity, Math.max(product.stock, 0)) });
  }
  return result;
}
