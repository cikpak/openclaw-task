import type { Message, ToolActivity } from '@messenger/contracts';
import { AttachmentLinks } from '../attachments/AttachmentPicker';
import { ArtifactLinks } from '../attachments/Artifacts';
import { record } from '../lib/validation';
import { HoverPopover } from '../ui/HoverPopover';
import { Icon, type IconName } from '../ui/Icon';
import styles from './Conversation.module.css';

// Decode only recognized text envelopes, never arbitrary objects or HTML.
export function toolResultText(text: string): string {
  if (text.length > 64 * 1024) return text;
  try {
    const parsed: unknown = JSON.parse(text);
    const content = record(parsed) ? parsed.content : parsed;
    if (
      Array.isArray(content) &&
      content.length > 0 &&
      content.every(
        (part) =>
          record(part) &&
          ['text', 'input_text', 'output_text'].includes(String(part.type)) &&
          typeof part.text === 'string',
      )
    )
      return content.map((part: { text: string }) => part.text).join('\n\n');
  } catch {
    // Plain text and unrecognized structured results remain available verbatim.
  }
  return text;
}

export function ToolResult({
  message,
  chatId,
}: {
  message: Message;
  chatId: string;
}) {
  return (
    <span
      className={styles.canonicalTool}
      data-message-id={message.id}
      data-message-role="tool"
      data-message-state="canonical"
    >
      <ToolChip name={message.toolName ?? 'Tool files'} status="recorded">
        {() => (
          <div className={styles.toolDetails}>
            <header>
              <strong>{message.toolName ?? 'Tool files'}</strong>
              <time dateTime={new Date(message.createdAt).toISOString()}>
                {new Date(message.createdAt).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </header>
            {message.toolName ? <ToolPreview text={message.text} /> : null}
            {message.attachments?.length ? (
              <AttachmentLinks attachments={message.attachments} />
            ) : null}
            {message.artifacts?.length ? (
              <ArtifactLinks chatId={chatId} artifacts={message.artifacts} />
            ) : null}
          </div>
        )}
      </ToolChip>
    </span>
  );
}

const toolNames: Record<string, string> = {
  write: 'Write',
  read: 'Read',
  edit: 'Edit',
  web_fetch: 'Fetch',
  web_search: 'Search',
  exec: 'Terminal',
  browser: 'Browser',
  image: 'Image',
};
const toolIcons: Record<string, IconName> = {
  read: 'file',
  read_file: 'file',
  write: 'write',
  write_file: 'write',
  edit: 'edit',
  edit_file: 'edit',
  apply_patch: 'edit',
  web_fetch: 'globe',
  browser: 'globe',
  web_search: 'search',
  search: 'search',
  exec: 'terminal',
  process: 'terminal',
  terminal: 'terminal',
  image: 'image',
  image_generation: 'image',
};
function toolKey(name: string) {
  return name.toLowerCase().split(/[.:/]/u).at(-1) ?? name;
}
function ToolChip({
  name,
  status,
  children,
}: {
  name: string;
  status: string;
  children: () => ReactNode;
}) {
  const key = toolKey(name);
  return (
    <HoverPopover
      label={`${name} · ${status} · Tool details`}
      className={styles.toolChip}
      trigger={
        <>
          <Icon
            name={Object.hasOwn(toolIcons, key) ? toolIcons[key]! : 'tool'}
          />
          <span className={styles.toolName}>
            {Object.hasOwn(toolNames, key) ? toolNames[key] : name}
          </span>
          <span className={styles.toolStatus} data-tool-status={status} />
        </>
      }
    >
      {children}
    </HoverPopover>
  );
}
function parameterFields(text: string): {
  fields: Array<[string, unknown]>;
  truncated: boolean;
} {
  if (text.length > 64 * 1024) return { fields: [], truncated: true };
  try {
    const parsed: unknown = JSON.parse(text);
    return {
      fields: record(parsed) ? Object.entries(parsed).slice(0, 30) : [],
      truncated: false,
    };
  } catch {
    // The server bounds serialized previews and may cut a long document in
    // the middle of its JSON string. Recover only known display-only string
    // fields; never interpret code, links, arbitrary objects or missing text.
    const fields: Array<[string, unknown]> = [];
    if (text.startsWith('{')) {
      const strings =
        /"(path|file_path|content|oldText|newText|url)"\s*:\s*"((?:[^"\\]|\\.)*)/gu;
      for (const match of text.matchAll(strings)) {
        try {
          fields.push([match[1]!, JSON.parse(`"${match[2]}"`)]);
        } catch {
          // An incomplete escape at the preview boundary is not valid text.
        }
      }
    }
    return { fields, truncated: fields.length > 0 };
  }
}
function ToolPreview({ text }: { text: string }) {
  const decoded = toolResultText(text);
  let display = decoded;
  if (decoded === text && text.length <= 64 * 1024) {
    try {
      display = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Plain text or a truncated upstream preview remains literal.
    }
  }
  return (
    <>
      <pre>{display.slice(0, 16384) || 'No text output.'}</pre>
      {display.length > 16384 ? (
        <p className={styles.previewNotice}>
          Preview limited. Full output remains in the agent’s transcript.
        </p>
      ) : null}
    </>
  );
}
export function ToolActivityCard({
  tool,
  message,
  chatId,
}: {
  tool: ToolActivity;
  message?: Message | undefined;
  chatId?: string | undefined;
}) {
  return (
    <span
      className={styles.tool}
      data-tool-id={tool.id}
      data-message-id={message?.id}
      data-message-role="tool"
    >
      <ToolChip name={tool.name} status={tool.status}>
        {() => (
          <ToolActivityDetails tool={tool} message={message} chatId={chatId} />
        )}
      </ToolChip>
    </span>
  );
}
function ToolActivityDetails({
  tool,
  message,
  chatId,
}: {
  tool: ToolActivity;
  message?: Message | undefined;
  chatId?: string | undefined;
}) {
  const parameters = parameterFields(tool.parameters);
  return (
    <div className={styles.toolDetails}>
      <header>
        <strong>{tool.name}</strong>
        <span>{tool.status}</span>
      </header>
      <h3>Parameters</h3>
      {parameters.fields.length ? (
        <dl className={styles.toolParameters}>
          {parameters.fields.map(([key, value]) => {
            const label =
              key === 'file_path'
                ? 'Path'
                : key === 'url'
                  ? 'URL'
                  : key.charAt(0).toUpperCase() +
                    key.slice(1).replace(/([a-z])([A-Z])/gu, '$1 $2');
            const text =
              typeof value === 'string'
                ? value
                : JSON.stringify(value, null, 2);
            return (
              <div key={key}>
                {key === 'content' ? (
                  <details className={styles.toolContent}>
                    <summary>
                      <Icon name="chevronDown" className={styles.toolChevron} />
                      Document content
                    </summary>
                    <ToolPreview text={text} />
                  </details>
                ) : (
                  <>
                    <dt>{label}</dt>
                    <dd>
                      <ToolPreview text={text} />
                    </dd>
                  </>
                )}
              </div>
            );
          })}
        </dl>
      ) : tool.parameters ? (
        <ToolPreview text={tool.parameters} />
      ) : (
        <p>No parameters.</p>
      )}
      {parameters.truncated ? (
        <p className={styles.previewNotice}>
          Parameters preview is truncated. Full content remains in the agent’s
          transcript.
        </p>
      ) : null}
      {tool.output ? (
        <>
          <h3>Result</h3>
          <ToolPreview text={tool.output} />
        </>
      ) : null}
      {message?.attachments?.length ? (
        <AttachmentLinks attachments={message.attachments} />
      ) : null}
      {message?.artifacts?.length && chatId ? (
        <ArtifactLinks chatId={chatId} artifacts={message.artifacts} />
      ) : null}
    </div>
  );
}
import type { ReactNode } from 'react';
