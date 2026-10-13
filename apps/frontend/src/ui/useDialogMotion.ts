import { useCallback, useEffect, useRef, useState } from 'react';

export function useDialogMotion(onClose: () => void) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requested = useRef(false);
  const closeCallback = useRef(onClose);
  useEffect(() => {
    closeCallback.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const close = useCallback(() => {
    if (requested.current) return;
    requested.current = true;
    setClosing(true);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      closeCallback.current();
    } else {
      timer.current = setTimeout(() => {
        timer.current = null;
        closeCallback.current();
      }, 180);
    }
  }, []);
  return { dialog, closing, close };
}
