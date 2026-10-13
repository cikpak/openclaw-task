import { useId } from 'react';
import type { ReactNode } from 'react';
import styles from './Ui.module.css';
import { Button } from './Button';
import { useDialogMotion } from './useDialogMotion';
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode | ((close: () => void) => ReactNode);
  onClose: () => void;
}) {
  const { dialog, closing, close } = useDialogMotion(onClose);
  const titleId = useId();
  return (
    <dialog
      ref={dialog}
      className={`${styles.modal} ${styles.dialogMotion}`}
      aria-labelledby={titleId}
      data-closing={closing || undefined}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className={styles.modalHeader}>
        <h2 id={titleId}>{title}</h2>
        <Button
          type="button"
          aria-label="Close dialog"
          icon="close"
          onClick={close}
        />
      </header>
      <fieldset className={styles.dialogContent} disabled={closing}>
        {typeof children === 'function' ? children(close) : children}
      </fieldset>
    </dialog>
  );
}
export function ErrorNotice({ message }: { message: string }) {
  return message ? (
    <p className={styles.error} role="alert">
      {message}
    </p>
  ) : null;
}
