import type { EngineContext } from '../manager/types.js';

export interface ExpectedIdentity {
  deviceId: string;
  publicKey: string;
  role: string;
  scopes: string[];
}
export interface HelperHealth {
  helperReady: boolean;
  gatewayState: string;
  bootId: string;
  initialized: boolean;
  restored: boolean;
  initialRootEmpty: boolean;
}
export interface HelperJob {
  operationId: string;
  bootId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  result?: unknown;
}
export class PrivateContainer {
  private monitoring = false;
  private intentional = false;
  private credentials: { helper: string; gateway: string };
  constructor(private readonly context: EngineContext) {
    this.credentials = this.loadCredentials();
  }
  private loadCredentials(): { helper: string; gateway: string } {
    const sql = this.context.state.storage.sql;
    sql.exec(
      'CREATE TABLE IF NOT EXISTS engine_credentials (id INTEGER PRIMARY KEY CHECK(id = 1), helper TEXT NOT NULL, gateway TEXT NOT NULL)',
    );
    const existing = [
      ...sql.exec<{ helper: string; gateway: string }>(
        'SELECT helper, gateway FROM engine_credentials WHERE id = 1',
      ),
    ][0];
    if (existing) return existing;
    const value = {
      helper: crypto.randomUUID() + crypto.randomUUID(),
      gateway: crypto.randomUUID() + crypto.randomUUID(),
    };
    sql.exec(
      'INSERT INTO engine_credentials VALUES (1, ?, ?)',
      value.helper,
      value.gateway,
    );
    return value;
  }
  secrets(): string[] {
    return [this.credentials.helper, this.credentials.gateway];
  }
  gatewayToken(): string {
    return this.credentials.gateway;
  }
  get container(): Container {
    const container = this.context.state.container;
    if (!container) throw new Error('Private engine binding unavailable');
    return container;
  }
  async inspect(): Promise<{ running: boolean; bootId?: string }> {
    if (!this.container.running) return { running: false };
    const health = await this.health();
    return { running: true, bootId: health.bootId };
  }
  async attach(): Promise<void> {
    if (!this.container.running) return;
    // The durable 20-second lifecycle alarm refreshes this watchdog. Never use
    // engine inactivity as the platform stop timer: preservation owns shutdown.
    await this.container.setInactivityTimeout(900_000);
    if (this.monitoring) return;
    this.monitoring = true;
    this.intentional = false;
    this.context.state.waitUntil(
      this.container.monitor().then(
        () => this.exited(),
        () => this.exited(),
      ),
    );
  }
  private async exited(): Promise<void> {
    this.monitoring = false;
    if (!this.intentional)
      await this.context.schedule.set('engine', Date.now() + 1);
  }
  async start(
    bootId: string,
    expected: ExpectedIdentity,
    restoreExpected: boolean,
  ): Promise<void> {
    if (this.container.running) return;
    const credentials = this.credentials;
    const env = this.context.env;
    this.container.start({
      image: this.container.images.base!,
      instance: 'standard-2',
      enableInternet: true,
      env: {
        HELPER_TOKEN: credentials.helper,
        GATEWAY_TOKEN: credentials.gateway,
        BOOT_ID: bootId,
        EXPECTED_MANAGER_DEVICE_ID: expected.deviceId,
        EXPECTED_MANAGER_PUBLIC_KEY: expected.publicKey,
        DEFAULT_MODEL: env.DEFAULT_MODEL ?? 'openai/gpt-5',
        R2_ORIGIN: env.R2_ORIGIN ?? '',
        ...(restoreExpected ? { RESTORE_EXPECTED: '1' } : {}),
        ...(env.OPENAI_API_KEY ? { OPENAI_API_KEY: env.OPENAI_API_KEY } : {}),
        ...(env.ANTHROPIC_API_KEY
          ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY }
          : {}),
      },
    });
    await this.attach();
  }
  async request<T>(path: string, data?: unknown): Promise<T> {
    const credentials = this.credentials;
    const response = await this.container
      .getTcpPort(8787)
      .fetch(`http://helper${path}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${credentials.helper}`,
          ...(data === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        signal: AbortSignal.timeout(15_000),
      });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Private engine helper unavailable');
    }
    return response.json<T>();
  }
  health(): Promise<HelperHealth> {
    return this.request('/health');
  }
  async startJob(
    id: string,
    bootId: string,
    action: string,
    data?: unknown,
  ): Promise<void> {
    await this.request('/jobs', {
      operationId: id,
      bootId,
      action,
      ...(data === undefined ? {} : { data }),
    });
  }
  job(id: string): Promise<HelperJob> {
    return this.request(`/jobs/${encodeURIComponent(id)}`);
  }
  async cancel(id: string, bootId: string): Promise<void> {
    await this.request(`/jobs/${encodeURIComponent(id)}/cancel`, { bootId });
  }
  async action(
    action: string,
    data?: unknown,
    timeoutMs = 90_000,
  ): Promise<unknown> {
    const health = await this.health();
    const id = `${action}-${crypto.randomUUID()}`;
    await this.startJob(id, health.bootId, action, data);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.job(id);
      if (result.bootId !== health.bootId)
        throw new Error('Stale private engine operation');
      if (result.status === 'succeeded') return result.result;
      if (result.status !== 'running')
        throw new Error('Private engine operation failed');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Private engine operation deadline exceeded');
  }
  async destroy(): Promise<void> {
    this.intentional = true;
    await this.container.destroy();
  }
}
