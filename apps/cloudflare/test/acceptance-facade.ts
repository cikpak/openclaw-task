import production from '../src/facade.js';
interface Env {
  BACKEND: Fetcher;
  MANAGER: Fetcher;
}
export default {
  fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/__acceptance/expire-sessions')
      return env.BACKEND.fetch(request);
    if (new URL(request.url).pathname.startsWith('/__acceptance/'))
      return env.MANAGER.fetch(request);
    return production.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;
