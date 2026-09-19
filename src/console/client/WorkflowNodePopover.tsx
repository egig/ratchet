import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useInternalNode, useReactFlow, useViewport } from '@xyflow/react';
import { XMarkIcon } from './icons.js';

/** A screen-sized form that follows its node without blocking the workflow canvas. */
export function WorkflowNodePopover({
  nodeId,
  title,
  canvasRef,
  anchorSelector,
  closeLabel = 'Close node editor',
  onClose,
  children,
}: {
  nodeId: string;
  title: string;
  canvasRef: RefObject<HTMLElement | null>;
  anchorSelector?: string;
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const node = useInternalNode(nodeId);
  const viewport = useViewport();
  const { flowToScreenPosition } = useReactFlow();
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 360, maxHeight: 480, ready: false });
  const titleId = `workflow-node-editor-${nodeId}`;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const canvas = canvasRef.current;
    if (!panel || !canvas || !node) return;
    const place = () => {
      const visible = window.visualViewport;
      const margin = 12;
      const left = (visible?.offsetLeft ?? 0) + margin;
      const top = (visible?.offsetTop ?? 0) + margin;
      const right = left + (visible?.width ?? window.innerWidth) - margin * 2;
      const bottom = top + (visible?.height ?? window.innerHeight) - margin * 2;
      const width = Math.min(360, right - left);
      const maxHeight = Math.min(480, bottom - top);
      const height = Math.min(panel.offsetHeight, maxHeight);
      const handle = anchorSelector
        ? canvas.querySelector(`[data-id="${CSS.escape(nodeId)}"] ${anchorSelector}`)?.getBoundingClientRect()
        : undefined;
      const anchor = handle ?? flowToScreenPosition(node.internals.positionAbsolute);
      const nodeRight = handle?.right ?? anchor.x + (node.measured.width ?? 160) * viewport.zoom;
      const nodeBottom = handle?.bottom ?? anchor.y + (node.measured.height ?? 80) * viewport.zoom;
      let x = nodeRight + margin;
      let y = anchor.y;
      if (x + width > right) {
        if (anchor.x - margin - width >= left) {
          x = anchor.x - margin - width;
        } else {
          x = anchor.x;
          y = nodeBottom + margin + height <= bottom
            ? nodeBottom + margin
            : anchor.y - margin - height;
        }
      }
      const next = {
        left: Math.max(left, Math.min(x, right - width)),
        top: Math.max(top, Math.min(y, bottom - height)),
        width,
        maxHeight,
        ready: true,
      };
      setPosition((current) =>
        current.ready && current.left === next.left && current.top === next.top &&
        current.width === next.width && current.maxHeight === next.maxHeight ? current : next,
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    observer.observe(canvas);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
      window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [node, viewport, flowToScreenPosition, canvasRef, nodeId, anchorSelector]);

  const close = () => {
    const anchor = canvasRef.current?.querySelector<HTMLElement>(
      `[data-id="${CSS.escape(nodeId)}"] ${anchorSelector ?? 'button'}`,
    );
    (anchor ?? canvasRef.current)?.focus({ preventScroll: true });
    onClose();
  };

  useLayoutEffect(() => {
    if (!position.ready) return;
    const panel = panelRef.current;
    const field = panel?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled)');
    (field ?? panel?.querySelector('[data-popover-body] button:not(:disabled)') ?? panel?.querySelector('button'))?.focus({ preventScroll: true });
  }, [position.ready]);

  useLayoutEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target)) onClose();
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-labelledby={titleId}
      className="nodrag nopan nowheel fixed z-40 flex flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-xl"
      style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, visibility: position.ready ? 'visible' : 'hidden' }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
        <h2 id={titleId} className="text-sm font-semibold">{title}</h2>
        <button type="button" aria-label={closeLabel} className="rounded p-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={close}>
          <XMarkIcon className="h-4 w-4" />
        </button>
      </div>
      <div data-popover-body className="min-h-0 overflow-y-auto overscroll-contain p-3">{children}</div>
    </div>,
    document.body,
  );
}
