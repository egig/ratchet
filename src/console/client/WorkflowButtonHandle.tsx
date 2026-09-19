import { Handle, Position, useConnection } from '@xyflow/react';
import { PlusIcon } from './icons.js';

/** Keep drag-to-connect available, with an attached shortcut for creating the next step. */
export function WorkflowButtonHandle({
  port,
  top,
  showButton,
  onAdd,
}: {
  port: string;
  top: string;
  showButton: boolean;
  onAdd: () => void;
}) {
  const connecting = useConnection((connection) => connection.inProgress);
  return (
    <>
      <Handle type="source" id={port} position={Position.Right} style={{ top }} />
      {showButton && !connecting && (
        <div className="nodrag nopan absolute left-full flex -translate-y-1/2 items-center" style={{ top }}>
          <span className="w-5 border-t border-border" />
          <button
            type="button"
            data-add-port={port}
            aria-label={`Add step on ${port}`}
            aria-haspopup="dialog"
            title={`Add step on ${port}`}
            className="flex size-7 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onAdd();
            }}
          >
            <PlusIcon className="size-4" />
          </button>
        </div>
      )}
    </>
  );
}
