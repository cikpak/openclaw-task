import { gatewayCapture } from './gateway-capture.mjs';
import { crashCategory, crashPhase } from './gateway-diagnostic.mjs';
import { createJobs as productionJobs } from './jobs.production.mjs';
import { crashGateway } from './gateway-crash.mjs';
export { validId } from './jobs.production.mjs';
/** This extra action is installed only by the acceptance Dockerfile. */
export const createJobs = (bootId, actions) =>
  productionJobs(bootId, {
    ...actions,
    'acceptance-crash': async (_data, signal) => {
      try {
        return await crashGateway({}, signal);
      } catch (error) {
        return {
          crashed: false,
          category: crashCategory(error),
          phase: crashPhase(error),
          capture: gatewayCapture.diagnostics(),
          ...(error.writerEvidence
            ? { writerEvidence: error.writerEvidence }
            : {}),
        };
      }
    },
  });
