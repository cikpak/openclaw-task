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
  descriptor?: RecoveryDescriptor;
  primary?: { action: string; data?: unknown };
  upload?: { checkpointId: string; grants: TransferGrant[]; reuse: string[] };
}
/** Durable composition makes helper start/status idempotent across DO recreation. */
export class RecoveryJobs {
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
      if (previous.cancelled) return;
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
    } else if (job.kind === 'capture') data = { checkpointId: job.id };
    else if (job.kind === 'resume') action = 'start';
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
    if (record.cancelled) {
      const result = await this.container.job(
        record.stage === 'upload' ? `${id}-upload` : id,
      );
      return {
        ...job,
        state: result.status === 'running' ? 'running' : 'cancelled',
      };
    }
    let result;
    try {
      result = await this.container.job(
        record.stage === 'upload' ? `${id}-upload` : id,
      );
    } catch {
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
    if (result.bootId !== job.bootId)
      throw new Error('Stale private operation result');
    if (result.status !== 'succeeded')
      return status(
        result.status === 'running'
          ? 'running'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'failed',
      );
    if (job.kind !== 'capture') return status('complete');
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
      record.upload = { checkpointId: descriptor.checkpointId, grants, reuse };
      record.stage = 'upload';
      await this.context.state.storage.put(this.key(id), record);
      await this.sendPrimary(record);
      return status('running');
    }
    if (!record.descriptor) throw new Error('Recovery descriptor unavailable');
    return status('complete', this.checkpoint(record.descriptor));
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
