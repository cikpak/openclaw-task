import { until } from './native-followup-fixture.mjs';

/** SDK hello may precede the exact helper pairing CLI job's physical completion. */
export async function bootstrapReady(gateway, control, pairing, pairingStatus) {
  await gateway.waitReady(240_000);
  const atSdkReady = {
    pairing: pairingStatus(),
    jobs: await control.jobStatus(),
  };
  const ready = await until(
    async () => {
      const current = pairing();
      await current;
      const values = await control.jobStatus();
      if (!values.every((value) => value.finishedAtPresent)) return false;
      await gateway.waitReady(240_000);
      return current === pairing() ? values : false;
    },
    'exact owned helper bootstrap completion',
    240_000,
  );
  return {
    atSdkReady,
    afterOwnedCompletion: { pairing: pairingStatus(), jobs: ready },
  };
}
