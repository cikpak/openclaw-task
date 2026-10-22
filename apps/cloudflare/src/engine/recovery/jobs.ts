import {
  assertVerification,
  type VerificationReceipt,
} from './verification.js';
import { base64 } from './encoding.js';
import type { EngineContext } from '../../manager/types.js';
import type { PrivateContainer } from '../container.js';
import type {
  LifecycleJob,
  JobStatus,
  RecoveryCheckpoint,
} from '../lifecycle/types.js';
import type { RecoveryObjects } from './objects.js';
import type { RecoveryDescriptor, TransferGrant } from './types.js';
interface CompositeJob {
  job: LifecycleJob;
  stage: 'primary' | 'upload' | 'complete';
  cancelled?: boolean;
  settled?: boolean;
  descriptor?: RecoveryDescriptor;
  verification?: VerificationReceipt;
  primary?: { action: string; data?: unknown };
  upload?: {
    checkpointId: string;
    grants: TransferGrant[];
    readbackGrants: TransferGrant[];
    reuse: string[];
  };
}
/** Durable composition makes helper start/status idempotent across DO recreation. */
export class RecoveryJobs {
  diagnostic: (kind: unknown, stage: unknown, status: unknown) => void =
    () => {};
  constructor(
    private readonly context: EngineContext,
    private readonly container: PrivateContainer,
    private readonly objects: RecoveryObjects,
    private readonly identity: () => Promise<unknown>,
  ) {}
  private key(id: string): string {
    return `engine-helper-${id}`;
  }
  async start(job: LifecycleJob): Promise<void> {
    const previous = await this.context.state.storage.get<CompositeJob>(
      this.key(job.id),
    );
    if (previous) {
      if (previous.cancelled || previous.settled) return;
      if (JSON.stringify(previous.job) !== JSON.stringify(job))
        throw new Error('Helper operation identity reused');
      await this.sendPrimary(previous);
      return;
    }
    const record: CompositeJob = { job, stage: 'primary' };
    // Persist intent before sending. Retrying start uses the same helper operation ID.
    await this.context.state.storage.put(this.key(job.id), record);
    await this.sendPrimary(record);
  }
  private async sendPrimary(record: CompositeJob): Promise<void> {
    const { job } = record;
    if (record.stage === 'upload' && record.upload) {
      await this.container.startJob(
        `${job.id}-upload`,
        job.bootId,
        'upload',
        record.upload,
      );
      return;
    }
    if (record.primary) {
      await this.container.startJob(
        job.id,
        job.bootId,
        record.primary.action,
        record.primary.data,
      );
      return;
    }
    let action: string = job.kind;
    let data: unknown;
    if (job.kind === 'initialize') data = { identity: await this.identity() };
    else if (job.kind === 'restore') {
      if (!job.checkpoint)
        throw new Error('Expected recovery reference missing');
      const descriptor = this.objects.descriptor(job.checkpoint);
      data = {
        descriptor,
        grants: await this.objects.grants(descriptor, 'GET'),
      };
    } else if (job.kind === 'capture') {
      const row = this.context.store.db
        .prepare('SELECT current FROM recovery_references WHERE id = 1')
        .get() as { current: string } | undefined;
      data = {
        checkpointId: job.id,
        previousFiles: row
          ? this.objects.descriptor(
              JSON.parse(row.current) as RecoveryCheckpoint,
            ).files
          : [],
      };
    } else if (job.kind === 'resume') action = 'start';
    record.primary = { action, ...(data === undefined ? {} : { data }) };
    await this.context.state.storage.put(this.key(job.id), record);
    await this.container.startJob(job.id, job.bootId, action, data);
  }
  async status(id: string): Promise<JobStatus> {
    const record = await this.context.state.storage.get<CompositeJob>(
      this.key(id),
    );
    if (!record) throw new Error('Private operation record unavailable');
    const { job } = record;
    const operationId = record.stage === 'upload' ? `${id}-upload` : id;
    if (record.settled)
      return {
        ...job,
        state: record.cancelled ? 'cancelled' : 'complete',
        ...(record.descriptor
          ? { checkpoint: this.checkpoint(record.descriptor) }
          : {}),
      };
    if (record.cancelled) {
      const result = await this.container.job(operationId);
      this.diagnostic(job.kind, record.stage, result.status);
      if (result.bootId !== job.bootId || result.operationId !== operationId)
        throw new Error('Stale private operation result');
      if (result.status !== 'running') {
        record.settled = true;
        await this.context.state.storage.put(this.key(id), record);
      }
      return {
        ...job,
        state: result.status === 'running' ? 'running' : 'cancelled',
      };
    }
    let result;
    try {
      result = await this.container.job(operationId);
      this.diagnostic(job.kind, record.stage, result.status);
    } catch {
      this.diagnostic(job.kind, record.stage, 'unavailable');
      await this.sendPrimary(record);
      return { ...job, state: 'running' };
    }
    const status = (
      state: JobStatus['state'],
      checkpoint?: RecoveryCheckpoint,
    ): JobStatus => ({
      id,
      bootId: job.bootId,
      attemptId: job.attemptId,
      state,
      ...(checkpoint ? { checkpoint } : {}),
    });
    if (result.bootId !== job.bootId || result.operationId !== operationId)
      throw new Error('Stale private operation result');
    if (result.status !== 'succeeded')
      return status(
        result.status === 'running'
          ? 'running'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'failed',
      );
    if (job.kind !== 'capture') {
      record.settled = true;
      await this.context.state.storage.put(this.key(id), record);
      return status('complete');
    }
    if (record.stage === 'primary') {
      record.descriptor = result.result as RecoveryDescriptor;
      const descriptor = record.descriptor;
      this.objects.descriptor(this.checkpoint(descriptor));
      const reuse: string[] = [];
      // Immutable content-addressed user objects can be reused after hash verification.
      for (const object of descriptor.files) {
        const remote = await this.context.env.RECOVERY_BUCKET?.head(object.key);
        if (
          remote?.size === object.size &&
          remote.checksums.md5 &&
          base64(remote.checksums.md5) === object.md5
        )
          reuse.push(object.key);
      }
      const grants = (await this.objects.grants(descriptor, 'PUT')).filter(
        (grant) => !reuse.includes(grant.key),
      );
      record.upload = {
        checkpointId: descriptor.checkpointId,
        grants,
        readbackGrants: await this.objects.grants(descriptor, 'GET'),
        reuse,
      };
      record.stage = 'upload';
      await this.context.state.storage.put(this.key(id), record);
      await this.sendPrimary(record);
      return status('running');
    }
    if (!record.descriptor) throw new Error('Recovery descriptor unavailable');
    const verification = (
      result.result as { verification?: unknown } | undefined
    )?.verification;
    await assertVerification(record.descriptor, verification);
    record.verification = verification as VerificationReceipt;
    record.settled = true;
    record.stage = 'complete';
    await this.context.state.storage.put(this.key(id), record);
    return status('complete', this.checkpoint(record.descriptor));
  }
  async verify(checkpoint: RecoveryCheckpoint): Promise<void> {
    const record = await this.context.state.storage.get<CompositeJob>(
      this.key(checkpoint.generation),
    );
    if (
      !record ||
      !record.settled ||
      record.cancelled ||
      record.stage !== 'complete' ||
      record.job.kind !== 'capture' ||
      !record.descriptor ||
      JSON.stringify(this.checkpoint(record.descriptor)) !==
        JSON.stringify(checkpoint)
    )
      throw new Error('Recovery readback completion unavailable');
    await assertVerification(record.descriptor, record.verification);
  }
  private checkpoint(descriptor: RecoveryDescriptor): RecoveryCheckpoint {
    return {
      generation: descriptor.checkpointId,
      manifestKey: descriptor.manifest.key,
      manifestSha256: descriptor.manifest.sha256,
      descriptor: { ...descriptor },
    };
  }
  async cancel(job: LifecycleJob): Promise<void> {
    const record = (await this.context.state.storage.get<CompositeJob>(
      this.key(job.id),
    )) ?? { job, stage: 'primary' };
    record.cancelled = true;
    await this.context.state.storage.put(this.key(job.id), record);
    await this.container.cancel(
      record.stage === 'upload' ? `${job.id}-upload` : job.id,
      job.bootId,
    );
  }
}
