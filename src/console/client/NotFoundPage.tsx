/** Generic not-found view — the console's catch-all (`ConsoleApp.tsx`'s `path="*"`), and also
 * what `/setup` renders once setup isn't required (root admin already exists, or `/setup` is
 * disguised as missing in production — see `SetupPage.tsx`). Deliberately says nothing else. */
export function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <div className="text-center">
        <h1 className="text-lg font-semibold text-foreground">Not found</h1>
        <p className="mt-1 text-sm text-muted-foreground">This page doesn't exist.</p>
      </div>
    </div>
  );
}
