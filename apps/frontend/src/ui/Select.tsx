import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole,
  useTransitionStyles,
  useTypeahead,
} from '@floating-ui/react';
import { Icon } from './Icon';
import styles from './Ui.module.css';

export type SelectOption = { value: string; label: string; disabled?: boolean };
export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (disabled && open) setOpen(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const elements = useRef<Array<HTMLElement | null>>([]);
  const labels = useRef<Array<string | null>>([]);
  useEffect(() => {
    labels.current = options.map((option) =>
      option.disabled ? null : option.label,
    );
  }, [options]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const { refs, floatingStyles, context } = useFloating({
    open: open && !disabled,
    onOpenChange: setOpen,
    placement: 'bottom-start',
    strategy: 'fixed',
    whileElementsMounted: (reference, floating, update) =>
      autoUpdate(reference, floating, update, { animationFrame: true }),
    middleware: [
      offset(6),
      flip({ padding: 8, boundary: [] }),
      shift({ padding: 8, boundary: [] }),
      size({
        padding: 8,
        boundary: [],
        apply({ rects, availableHeight, availableWidth, elements }) {
          Object.assign(elements.floating.style, {
            width: `${rects.reference.width}px`,
            maxWidth: `${availableWidth}px`,
            maxHeight: `${Math.max(0, Math.min(280, availableHeight))}px`,
          });
        },
      }),
    ],
  });
  const click = useClick(context, { enabled: !disabled });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'select' });
  const navigation = useListNavigation(context, {
    listRef: elements,
    activeIndex,
    selectedIndex,
    onNavigate(index) {
      setActiveIndex(index);
      // Keyboard events can arrive before Floating UI's next animation frame.
      // Keep actual option focus in step with navigation, including rapid reopen.
      if (index !== null)
        elements.current[index]?.focus({ preventScroll: true });
    },
    loop: true,
    disabledIndices: options.flatMap((option, index) =>
      option.disabled ? [index] : [],
    ),
  });
  const typeahead = useTypeahead(context, {
    listRef: labels,
    activeIndex,
    selectedIndex,
    onMatch(index) {
      if (open) setActiveIndex(index);
      else if (options[index] && !options[index].disabled)
        onChange(options[index].value);
    },
  });
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions(
    [click, dismiss, role, navigation, typeahead],
  );
  const reducedMotion =
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const transition = useTransitionStyles(context, {
    duration: reducedMotion ? 0 : 160,
    initial: { opacity: 0, transform: 'translateY(-4px)' },
    open: { opacity: 1, transform: 'translateY(0)' },
    close: { opacity: 0, transform: 'translateY(-4px)' },
  });
  useLayoutEffect(() => {
    const menu = context.elements.floating;
    // A body portal is inert behind a native modal. Keep that portal owned by
    // the dialog, then lift it into the browser's top layer to escape clipping.
    if (!transition.isMounted || !menu?.showPopover) return;
    menu.showPopover();
    return () => {
      if (menu.isConnected) menu.hidePopover();
    };
  }, [context.elements.floating, transition.isMounted]);
  function select(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    setOpen(false);
    if (refs.domReference.current instanceof HTMLElement)
      refs.domReference.current.focus();
  }
  return (
    <>
      <button
        type="button"
        className={styles.select}
        disabled={disabled}
        data-value={value}
        aria-label={label}
        ref={(node) => {
          refs.setReference(node);
          if (node) {
            const root = node.closest('dialog');
            if (root !== portalRoot) setPortalRoot(root);
          }
        }}
        {...getReferenceProps({
          onKeyDown(event) {
            if (open && event.key === 'Escape') event.preventDefault();
          },
        })}
      >
        <span>{options[selectedIndex]?.label ?? value}</span>
        <Icon name="chevronDown" />
      </button>
      {transition.isMounted && !disabled ? (
        <FloatingPortal root={portalRoot ?? undefined}>
          <FloatingFocusManager
            context={context}
            modal={false}
            initialFocus={-1}
            returnFocus
          >
            <div
              popover={
                typeof HTMLElement.prototype.showPopover === 'function'
                  ? 'manual'
                  : undefined
              }
              ref={(node) => refs.setFloating(node)}
              style={floatingStyles}
              {...getFloatingProps({
                'aria-label': `${label} options`,
                className: styles.selectMenu,
                onKeyDown(event) {
                  if (open && event.key === 'Escape') event.preventDefault();
                },
              })}
            >
              <div style={transition.styles} className={styles.selectOptions}>
                {options.map((option, index) => (
                  <button
                    type="button"
                    data-value={option.value}
                    key={option.value}
                    ref={(node) => {
                      elements.current[index] = node;
                    }}
                    {...getItemProps({
                      role: 'option',
                      'aria-selected': index === selectedIndex,
                      'aria-disabled': option.disabled || undefined,
                      disabled: option.disabled,
                      tabIndex: activeIndex === index ? 0 : -1,
                      className: styles.selectOption,
                      onClick: () => select(index),
                      onKeyDown(event) {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          select(index);
                        }
                      },
                    })}
                  >
                    <span>{option.label}</span>
                    <span className={styles.iconSlot}>
                      {index === selectedIndex ? <Icon name="check" /> : null}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      ) : null}
    </>
  );
}
