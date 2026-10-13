import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon';
import styles from './Ui.module.css';

export function Button({
  busy = false,
  icon,
  children,
  className = '',
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy?: boolean;
  icon?: IconName;
}) {
  return (
    <button
      {...props}
      className={`${styles.button} ${className}`}
      aria-busy={busy || undefined}
      disabled={disabled || busy}
    >
      <span className={styles.iconSlot} aria-hidden="true">
        <span className={busy ? styles.spinner : undefined}>
          {busy ? <Icon name="spinner" /> : icon ? <Icon name={icon} /> : null}
        </span>
      </span>
      {children ? <span>{children}</span> : null}
    </button>
  );
}
