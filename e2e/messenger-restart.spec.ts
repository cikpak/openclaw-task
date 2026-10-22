import { restartEvidence } from './restart-evidence.js';
import {
  acceptanceControl,
  acceptanceJournalProof,
} from './runtime-control.js';
import { expect, test } from '@playwright/test';

import { createChat, idle, send, transcript } from './helpers.js';

import { messengerSetup, restartTitle } from './messenger-setup.js';
messengerSetup();

test(restartTitle, async ({ page }) => {
  test.setTimeout(360_000);
  const project = process.env.ACCEPTANCE_PROJECT;
  test.skip(
    !project,
    'Run pnpm test:acceptance for isolated runtime restart checks.',
  );
  expect(project).toMatch(/^messenger-acceptance-[a-z0-9-]+$/u);
  await createChat(page, 'Restart space');
  await send(page, 'LONG_RESPONSE_FIXTURE active before backend restart');
  await send(page, 'Durable queued message after backend restart');
  restartEvidence?.mark('before-manager-restart');
  await acceptanceControl('restart-manager');
  restartEvidence?.mark('after-manager-restart');
  await idle(page);
  await expect(
    transcript(page).filter({
      hasText: 'Durable queued message after backend restart',
    }),
  ).toHaveCount(1);
  await expect(
    transcript(page).filter({
      hasText: 'LONG_RESPONSE_FIXTURE active before backend restart',
    }),
  ).toHaveCount(1);
  await expect(
    transcript(page).filter({ hasText: 'Real Gateway integration response.' }),
  ).toHaveCount(2);
  await send(page, 'RESTART_RESPONSE_FIXTURE active before Gateway restart');
  await send(page, 'Accepted queue while Gateway restarts');
  await expect(
    page.getByText('Agent is working', { exact: false }),
  ).toBeVisible();
  await page
    .getByRole('textbox', { name: /^Message /u })
    .fill('Kept through Gateway restart');
  restartEvidence?.mark('before-gateway-stop');
  await acceptanceControl('restart-gateway');
  restartEvidence?.mark('after-gateway-start');
  await expect(page.getByRole('textbox', { name: /^Message /u })).toHaveValue(
    'Kept through Gateway restart',
  );
  const activeMarker = 'RESTART_RESPONSE_FIXTURE active before Gateway restart';
  const successorMarker = 'Accepted queue while Gateway restarts';
  const originalCanonical = transcript(page)
    .and(
      page.locator(
        '[data-message-role="user"][data-message-state="canonical"]',
      ),
    )
    .filter({ hasText: activeMarker });
  const unconfirmed = page
    .getByRole('article', { name: /^Queued message /u })
    .filter({ hasText: activeMarker });
  const retainedQueue = page
    .getByRole('article', { name: /^Queued message /u })
    .filter({ hasText: successorMarker });
  const request = restartEvidence?.request();
  expect(
    request,
    'The original send must have been observed passively',
  ).toBeTruthy();
  let outcome: 'confirmed' | 'unresolved' | undefined;
  // The oracle reads only after resume and exposes exact scoped journal proof as booleans.
  await expect
    .poll(
      async () => {
        const proof = await acceptanceJournalProof(request!);
        const snapshot = restartEvidence?.state();
        if (!proof || !snapshot) return 'waiting';
        restartEvidence?.oracle(proof);
        if (proof.pendingReceipt) return 'waiting';
        const originalPending = snapshot.pending.filter(
          (item) => item.marker === 'active-input',
        );
        const confirmed =
          !proof.cancelledReceipt &&
          proof.accepted &&
          proof.queryScoped &&
          proof.journaledUser &&
          proof.stableId &&
          proof.positiveSequence;
        if (
          confirmed &&
          snapshot.canonical['active-input'] === 1 &&
          originalPending.length === 0
        )
          outcome = 'confirmed';
        else if (
          proof.accepted &&
          proof.queryScoped &&
          !snapshot.activeRun &&
          originalPending.length === 1 &&
          originalPending[0]?.state === 'unknown' &&
          snapshot.canonical['queued-followup'] === 0 &&
          snapshot.pending.some(
            (item) =>
              item.marker === 'queued-followup' && item.state === 'pending',
          )
        )
          outcome = 'unresolved';
        return outcome ?? 'waiting';
      },
      { timeout: 120_000 },
    )
    .toMatch(/^(confirmed|unresolved)$/u);
  if (outcome === 'confirmed') {
    await expect(originalCanonical).toHaveCount(1);
    await expect(unconfirmed).not.toBeVisible();
    const continuation = transcript(page).filter({
      hasText:
        '[System] Your previous turn was interrupted by a gateway restart',
    });
    // Continuation may use a new native run; identity matches remain diagnostic only.
    await expect
      .poll(
        async () =>
          restartEvidence?.state()?.assistantRunMatches['active-input'] ===
            true ||
          (await continuation
            .locator(
              'xpath=following-sibling::article[1][@data-message-role="assistant" and @data-message-state="canonical"]',
            )
            .filter({ hasText: 'Real Gateway integration response.' })
            .count()) === 1,
        { timeout: 60_000 },
      )
      .toBe(true);
  } else {
    // Outcome remains unconfirmed: retain the accepted input and fence its successor.
    await expect(unconfirmed).toHaveCount(1);
    await expect(unconfirmed).toContainText('Delivery unconfirmed');
    await expect(unconfirmed).toContainText(activeMarker);
    expect(await originalCanonical.count()).toBeLessThanOrEqual(1);
    await expect(retainedQueue).toHaveCount(1);
    await expect(
      transcript(page).filter({ hasText: successorMarker }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Stop this run', exact: true }),
    ).not.toBeVisible();
    await unconfirmed
      .getByRole('button', { name: 'Discard', exact: true })
      .click();
  }
  // A submitted queue card can briefly have a timestamp alongside its canonical
  // user turn. Match committed history, not both copies during reconciliation.
  const queuedCanonical = transcript(page)
    .and(
      page.locator(
        '[data-message-role="user"][data-message-state="canonical"]',
      ),
    )
    .filter({ hasText: 'Accepted queue while Gateway restarts' });
  // Idle can briefly appear between recovery resolution and asynchronous
  // dispatch. Wait for this item's canonical turn, not that intermediate state.
  await expect(queuedCanonical).toHaveCount(1, { timeout: 60_000 });
  await expect(
    queuedCanonical.locator(
      'xpath=following-sibling::article[1][@data-message-role="assistant" and @data-message-state="canonical"]',
    ),
  ).toContainText('Real Gateway integration response.', { timeout: 60_000 });
  await idle(page);
  await expect(unconfirmed).not.toBeVisible();
  const completedBeforeFollowup = await transcript(page)
    .filter({ hasText: 'Real Gateway integration response.' })
    .count();
  await send(page, 'Message after Gateway restart');
  await idle(page);
  await expect(
    transcript(page).filter({ hasText: 'Message after Gateway restart' }),
  ).toHaveCount(1);
  await expect(
    transcript(page).filter({ hasText: 'Real Gateway integration response.' }),
  ).toHaveCount(completedBeforeFollowup + 1);
  if (outcome === 'confirmed') await expect(originalCanonical).toHaveCount(1);
  else expect(await originalCanonical.count()).toBeLessThanOrEqual(1);
});
