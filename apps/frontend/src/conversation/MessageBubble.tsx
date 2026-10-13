import { Fragment, type ReactNode } from 'react';
import type {
  ChatSnapshot,
  Message,
  SettledRun,
  ToolActivity,
} from '@messenger/contracts';
import { AttachmentLinks } from '../attachments/AttachmentPicker';
import { ArtifactLinks } from '../attachments/Artifacts';
import { Button } from '../ui/Button';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ToolResult, ToolActivityCard } from './ToolResult';
import { AgentMessageContent } from './AgentMessageContent';
import styles from './Conversation.module.css';

function MessageBubble({
  message,
  chatId,
  active,
  settled,
  usingTools,
  aborting,
  onAbort,
}: {
  message: Message;
  chatId: string;
  active?: ChatSnapshot['activeRun'];
  settled?: SettledRun | undefined;
  usingTools: boolean;
  aborting: boolean;
  onAbort: () => void;
}) {
  return (
    <article
      className={`${styles.message} ${message.role === 'user' ? styles.userMessage : styles.agentMessage}`}
      data-message-id={message.id}
      data-message-role={message.role}
      data-message-state={active ? 'active' : settled ? 'settled' : 'canonical'}
    >
      <header>
        {message.role === 'user'
          ? 'You'
          : message.role === 'tool'
            ? 'Tool output'
            : 'Agent'}
        {settled ? (
          <span className={styles.settledLabel}>
            {settled.state === 'final'
              ? 'Response complete · syncing transcript'
              : settled.state === 'aborted'
                ? 'Stopped · partial response'
                : 'Interrupted · partial response'}
          </span>
        ) : active ? (
          <span className={styles.working}>Working</span>
        ) : (
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {new Date(message.createdAt).toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        )}
      </header>
      {active && !message.text.trim() ? (
        <ThinkingIndicator usingTools={usingTools} />
      ) : message.role === 'assistant' ? (
        <AgentMessageContent text={message.text} chatId={chatId} />
      ) : (
        <p data-message-content data-message-source-size={message.text.length}>
          {message.text}
        </p>
      )}
      {message.attachments ? (
        <AttachmentLinks attachments={message.attachments} />
      ) : null}
      {message.artifacts ? (
        <ArtifactLinks chatId={chatId} artifacts={message.artifacts} />
      ) : null}
      {active?.truncated ? (
        <p className={styles.previewNotice} role="status">
          Live preview is limited to 256 KiB. The full output is retained in the
          agent’s transcript.
        </p>
      ) : null}
      {active ? (
        <Button
          busy={aborting}
          icon="stop"
          type="button"
          className={styles.stop}
          onClick={onAbort}
        >
          Stop this run
        </Button>
      ) : null}
    </article>
  );
}

export function ConversationMessages({
  snapshot,
  tools,
  aborting,
  onAbort,
  children,
}: {
  snapshot: ChatSnapshot;
  tools: ToolActivity[];
  aborting: boolean;
  onAbort: () => void;
  children?: ReactNode;
}) {
  const active = snapshot.activeRun;
  const settled = snapshot.settledRun;
  const preview = active ?? settled;
  const matched =
    !active &&
    settled &&
    snapshot.messages.findLast(
      (message) =>
        message.role === 'assistant' &&
        message.runId === settled.id &&
        message.text === settled.text,
    );
  const visibleMessages = snapshot.messages.filter(
    (message) =>
      message.role === 'user' ||
      (message.role === 'tool' && message.toolName) ||
      (message.role === 'assistant' && message.text.trim()) ||
      message.attachments?.length ||
      message.artifacts?.length,
  );
  const matchedTools = new Map<string, ToolActivity>();
  const usedTools = new Set<string>();
  for (const message of visibleMessages) {
    if (message.role !== 'tool' || !message.toolCallId) continue;
    const candidates = tools.filter(
      (tool) =>
        tool.name === message.toolName &&
        tool.id.endsWith(`:${message.toolCallId}`) &&
        (!message.runId ||
          tool.id === `${message.runId}:${message.toolCallId}`),
    );
    const tool = candidates.length === 1 ? candidates[0] : undefined;
    if (tool && !usedTools.has(tool.id)) {
      matchedTools.set(message.id, tool);
      usedTools.add(tool.id);
    }
  }
  const rows = visibleMessages.map((message) => {
    const latestForRun =
      message.role === 'assistant' &&
      message.runId &&
      visibleMessages.findLast(
        (item) => item.role === 'assistant' && item.runId === message.runId,
      ) === message;
    return {
      message,
      key: matchedTools.has(message.id)
        ? `tool-activity-${matchedTools.get(message.id)!.id}`
        : message === matched || (latestForRun && message.runId !== preview?.id)
          ? `run-${message.runId}`
          : `message-${message.id}`,
    };
  });
  // One flat keyed list preserves the live bubble across canonical handoff.
  const content = [
    ...rows.map(({ message, key }) =>
      matchedTools.has(message.id) ? (
        <ToolActivityCard
          key={key}
          tool={matchedTools.get(message.id)!}
          message={message}
          chatId={snapshot.chat.id}
        />
      ) : message.role === 'tool' ? (
        <ToolResult key={key} message={message} chatId={snapshot.chat.id} />
      ) : (
        <MessageBubble
          key={key}
          message={message}
          chatId={snapshot.chat.id}
          usingTools={false}
          aborting={aborting}
          onAbort={onAbort}
        />
      ),
    ),
    ...tools
      .filter((tool) => !usedTools.has(tool.id))
      .map((tool) => (
        <ToolActivityCard key={`tool-activity-${tool.id}`} tool={tool} />
      )),
    <Fragment key="queued-content">{children}</Fragment>,
  ];
  // Existing commentary, tools, and submitted inputs precede the current reply.
  if (preview && !matched)
    content.push(
      <MessageBubble
        key={`run-${preview.id}`}
        message={{
          id: preview.id,
          role: 'assistant',
          text: preview.text,
          createdAt: 0,
          runId: preview.id,
        }}
        chatId={snapshot.chat.id}
        active={active}
        settled={active ? undefined : settled}
        usingTools={tools.some((tool) => tool.status === 'running')}
        aborting={aborting}
        onAbort={onAbort}
      />,
    );
  return (
    <>
      {visibleMessages.length === 0 && !preview ? (
        <div className={styles.emptyChat}>
          <span className={styles.emptyGlyph} aria-hidden="true">
            ✳
          </span>
          <h2>A little space to think.</h2>
          <p>
            This agent is ready to help. Start with a question
            <br className={styles.desktopBreak} /> or tell it what you’re
            working on.
          </p>
        </div>
      ) : null}
      {content}
    </>
  );
}
