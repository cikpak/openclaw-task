import { useLayoutEffect, useState, type ReactNode } from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  safePolygon,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
  useTransitionStyles,
} from '@floating-ui/react';
import styles from './HoverPopover.module.css';

export function HoverPopover({
  label,
  trigger,
  className,
  children,
}: {
  label: string;
  trigger: ReactNode;
  className: string | undefined;
  children: () => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    strategy: 'fixed',
    whileElementsMounted: (reference, floating, update) =>
      autoUpdate(reference, floating, update, { animationFrame: true }),
    middleware: [
      offset(8),
      flip({ padding: 12, boundary: [] }),
      shift({ padding: 12, boundary: [] }),
      size({
        padding: 12,
        boundary: [],
        apply({ availableHeight, availableWidth, elements }) {
          Object.assign(elements.floating.style, {
            maxWidth: `${Math.max(0, availableWidth)}px`,
            maxHeight: `${Math.max(0, Math.min(420, availableHeight))}px`,
          });
        },
      }),
    ],
  });
  const hover = useHover(context, {
    delay: { open: 200, close: 80 },
    mouseOnly: true,
    handleClose: safePolygon(),
  });
  const focus = useFocus(context, { visibleOnly: false });
  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
    click,
    dismiss,
    role,
  ]);
  const reducedMotion =
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const transition = useTransitionStyles(context, {
    duration: reducedMotion ? 0 : 160,
    initial: { opacity: 0, transform: 'translateY(4px)' },
    open: { opacity: 1, transform: 'translateY(0)' },
    close: { opacity: 0, transform: 'translateY(4px)' },
  });
  useLayoutEffect(() => {
    const popup = context.elements.floating;
    if (!transition.isMounted || !popup?.showPopover) return;
    popup.showPopover();
    return () => {
      if (popup.isConnected) popup.hidePopover();
    };
  }, [context.elements.floating, transition.isMounted]);
  return (
    <>
      <button
        type="button"
        className={className}
        ref={(node) => {
          refs.setReference(node);
          if (node) {
            const root = node.closest('dialog');
            if (root !== portalRoot) setPortalRoot(root);
          }
        }}
        {...getReferenceProps({ 'aria-label': label })}
      >
        {trigger}
      </button>
      {transition.isMounted ? (
        <FloatingPortal root={portalRoot ?? undefined}>
          <FloatingFocusManager
            context={context}
            modal={false}
            initialFocus={-1}
            returnFocus
          >
            <div
              ref={(node) => refs.setFloating(node)}
              popover={
                typeof HTMLElement.prototype.showPopover === 'function'
                  ? 'manual'
                  : undefined
              }
              style={floatingStyles}
              {...getFloatingProps({
                'aria-label': label,
                className: styles.positioner,
              })}
            >
              <div className={styles.surface} style={transition.styles}>
                {children()}
              </div>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      ) : null}
    </>
  );
}
