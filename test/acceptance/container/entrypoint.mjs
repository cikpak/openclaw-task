import { installGatewayCapture } from './gateway-capture.mjs';
import { startProvider } from './provider.mjs';
await startProvider();
installGatewayCapture();
await import('./start.mjs');
