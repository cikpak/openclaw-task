import { afterEach, expect, it } from 'vitest';
import { lifecycleFixture } from './fixture.js';
const fixtures: ReturnType<typeof lifecycleFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach((fixture) => fixture.close()));
function setup() {
  const fixture = lifecycleFixture();
  fixtures.push(fixture);
  return fixture;
}

it('gates dispatch until usable Gateway readiness and closes it before preservation', async () => {
  const f = setup();
  let dispatch = true;
  f.driver.dispatch = (enabled) => {
    dispatch = enabled;
  };
  f.recreate();
  expect(dispatch).toBe(false);
  f.driver.connect = () => Promise.resolve(false);
  await f.core.requestWake();
  await f.until('connecting');
  await f.core.tick();
  expect(f.core.status).toBe('connecting');
  expect(f.core.ready).toBe(false);
  expect(dispatch).toBe(false);
  expect(f.core.deadline()).toBe(f.time + 1000);
  f.driver.connect = () => Promise.resolve(true);
  f.driver.onReady = () => {
    expect(dispatch).toBe(true);
    return Promise.resolve();
  };
  await f.until('ready');
  expect(f.core.ready).toBe(true);
  f.time += 60_001;
  await f.core.tick();
  expect(f.core.status).toBe('preparing');
  expect(dispatch).toBe(false);
});

it('ready state after recreation remains gated while authentication is pending', async () => {
  const f = setup();
  await f.wake();
  f.recreate();
  f.driver.connect = () => Promise.resolve(false);
  await f.core.tick();
  expect(f.core.ready).toBe(false);
  expect(f.core.snapshot().failure).toBeNull();
  f.driver.connect = () => Promise.resolve(true);
  await f.core.tick();
  expect(f.core.ready).toBe(true);
});

it('bounds long helper jobs while preserving the local disk', async () => {
  const f = setup();
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('capturing');
  f.held.add('capture');
  await f.core.tick();
  f.time += 15 * 60_000 + 1;
  await f.core.tick();
  expect(f.core.status).toBe('cancelling');
  expect(f.calls).not.toContain('destroy');
  await f.core.requestWake();
  await f.until('ready');
  expect(f.calls).toContain('cancel');
  expect(f.calls).not.toContain('restore');
});

it('commits application file references and generation state in one SQLite transaction', async () => {
  const f = setup();
  f.storage.sql.exec('CREATE TABLE test_file_references (generation TEXT)');
  await f.wake();
  f.time += 60_001;
  await f.core.tick();
  await f.until('committing');
  f.driver.commit = (checkpoint) => {
    f.storage.sql.exec(
      'INSERT INTO test_file_references VALUES (?)',
      checkpoint.generation,
    );
    throw Error('Simulated metadata commit failure');
  };
  await f.core.tick();
  expect([
    ...f.storage.sql.exec('SELECT * FROM test_file_references'),
  ]).toHaveLength(0);
  f.recreate();
  expect(f.core.snapshot().checkpoint).toBeNull();
  expect(f.calls).not.toContain('destroy');
});

it('Gateway connectivity drift gates dispatch and reconnects against the same live disk', async () => {
  const f = setup();
  await f.wake();
  const boot = f.core.snapshot().bootId;
  let enabled = true;
  f.driver.dispatch = (value) => {
    enabled = value;
  };
  f.driver.connected = () => false;
  f.driver.connect = () => Promise.resolve(false);
  await f.core.tick();
  expect(f.core.ready).toBe(false);
  expect(enabled).toBe(false);
  expect(f.core.snapshot().bootId).toBe(boot);
  expect(f.calls).not.toContain('restore');
  expect(f.calls).not.toContain('destroy');
  f.driver.connected = () => true;
  f.driver.connect = () => Promise.resolve(true);
  await f.core.tick();
  expect(f.core.ready).toBe(true);
  expect(enabled).toBe(true);
  expect(f.calls.filter((call) => call === 'initialize')).toHaveLength(1);
});
