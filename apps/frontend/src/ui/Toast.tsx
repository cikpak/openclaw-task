/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- Keyboard readers must be able to focus the notification group to pause expiry. */
import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import styles from '../App.module.css';

export function Toast({
  text,
  onDismiss,
}: {
  text: string;
  onDismiss: () => void;
}) {
  const [focused, setFocused] = useState(false);
  const [closing, setClosing] = useState(false);
  const remaining = useRef(3000);
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    if (focused || closing) return;
    const started = Date.now();
    const timer = setTimeout(() => setClosing(true), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(
        0,
        remaining.current - (Date.now() - started),
      );
    };
  }, [focused, closing]);
  useEffect(() => {
    if (!closing) return;
    const delay = window.matchMedia?.('(prefers-reduced-motion: reduce)')
      .matches
      ? 0
      : 180;
    const timer = setTimeout(() => dismiss.current(), delay);
    return () => clearTimeout(timer);
  }, [closing]);
  return (
    <div
      className={styles.toast}
      role="group"
      aria-label="Notification"
      tabIndex={0}
      data-closing={closing || undefined}
      onFocusCapture={() => {
        setFocused(true);
        setClosing(false);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <p>{text}</p>
      <Button
        type="button"
        aria-label="Dismiss notification"
        icon="close"
        onClick={() => setClosing(true)}
      />
    </div>
  );
}
