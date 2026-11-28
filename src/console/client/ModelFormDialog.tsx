import { useNavigate } from './router.js';
import { Dialog } from './Dialog.js';
import { ModelFormPage } from './ModelFormPage.js';

export interface ModelFormDialogProps {
  /** where to navigate once the dialog closes (Cancel, a successful save, Escape, backdrop click)
   * — the page it's layered over, e.g. `/${model.name}` or `/workspace/${workspaceId}`. */
  returnTo: string;
}

/** Renders the create/edit form as a dialog over whatever route it's nested under
 * (`ModelListPage`'s `new`/`:id` sub-routes, `WorkspacePage`'s `:model/new`/`:model/:id`
 * sub-routes) instead of navigating to a full page — the page underneath stays mounted the whole
 * time, so its state (a workspace's active tab and chat panel, a list's pagination) survives. */
export function ModelFormDialog({ returnTo }: ModelFormDialogProps) {
  const navigate = useNavigate();
  const close = () => navigate(returnTo);
  return (
    <Dialog onClose={close}>
      <ModelFormPage onDone={close} />
    </Dialog>
  );
}
