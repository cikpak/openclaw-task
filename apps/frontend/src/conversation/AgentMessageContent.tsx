import { memo } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './Conversation.module.css';
import { remarkFileReferences } from './file-reference-markdown';
import {
  AgentFileChat,
  AgentFileLink,
  isAgentFileReference,
} from '../attachments/AgentFileLink';

const plugins = [remarkGfm, remarkFileReferences];
const safeUrl = (url: string) =>
  isAgentFileReference(url)
    ? url
    : /^(?:https?:|mailto:)/iu.test(url)
      ? defaultUrlTransform(url)
      : '';
const components: Components = {
  code({ children, className }) {
    // Fenced code includes a trailing newline; only an exact inline reference
    // becomes a download. Native paths never reach the resolver.
    return typeof children === 'string' && isAgentFileReference(children) ? (
      <AgentFileLink href={children}>Download file</AgentFileLink>
    ) : (
      <code className={className}>{children}</code>
    );
  },
  a({ href, children, title }) {
    if (href && isAgentFileReference(href))
      return <AgentFileLink href={href}>{children}</AgentFileLink>;
    return href ? (
      <a href={href} title={title} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    );
  },
  // Model-generated URLs must never fetch remote images merely by being rendered.
  img({ src, alt }) {
    const description = `Image: ${alt || 'Untitled image'}`;
    if (typeof src === 'string' && isAgentFileReference(src))
      return <AgentFileLink href={src}>{description}</AgentFileLink>;
    return typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {description}
      </a>
    ) : (
      <span>{description}</span>
    );
  },
  table({ children }) {
    return (
      <div className={styles.tableScroll}>
        <table>{children}</table>
      </div>
    );
  },
};

/** Parse only changed response text; unrelated queue/tool updates reuse the tree. */
export const AgentMessageContent = memo(function AgentMessageContent({
  text,
  chatId,
}: {
  text: string;
  chatId?: string | undefined;
}) {
  return (
    <div
      data-message-content
      data-message-source-size={text.length}
      className={`${styles.markdown} ${styles.replyText}`}
    >
      <AgentFileChat.Provider value={chatId ?? null}>
        <Markdown
          remarkPlugins={plugins}
          components={components}
          urlTransform={safeUrl}
          skipHtml
        >
          {text}
        </Markdown>
      </AgentFileChat.Provider>
    </div>
  );
});
