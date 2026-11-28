import { Route, Routes, useLocation, useParams } from './router.js';
import { useModels } from './models.js';
import { RowTable } from './RowTable.js';
import { ModelFormDialog } from './ModelFormDialog.js';

/** Plain "browse this model" route — default sort, with `RowTable`'s built-in ad-hoc filter
 * builder (its clauses live in `?filter=`, not persisted). The table/pagination/New-Edit-Delete
 * rendering itself lives in `RowTable`, shared with `WorkspaceViewTable` (a saved
 * filter/sort/columns configuration against the same generic `/api/:model` data).
 *
 * Matched against `:model/*` (see ConsoleApp.tsx) so its own `new`/`:id` sub-routes render the
 * form as a dialog on top of this table instead of navigating to a full page — the table (and its
 * pagination state) stays mounted underneath. */
export function ModelListPage() {
  const { model: modelName } = useParams<{ model: string }>();
  const { search } = useLocation();
  const { getModel, loading: modelsLoading } = useModels();
  const model = modelName ? getModel(modelName) : undefined;

  if (modelsLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!model) return <p className="text-sm text-destructive">Unknown model.</p>;

  // carry the current query string (RowTable's ad-hoc `?filter=`) through the form dialog so
  // closing it lands back on the same filtered listing.
  const returnTo = `/${model.name}${search}`;

  return (
    <>
      <RowTable model={model} query={{}} />
      <Routes>
        <Route path="new" element={<ModelFormDialog returnTo={returnTo} />} />
        <Route path=":id" element={<ModelFormDialog returnTo={returnTo} />} />
      </Routes>
    </>
  );
}
