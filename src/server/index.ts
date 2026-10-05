import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { ConfigError, isLoopbackHost, loadConfig } from './config';
import { createApp } from './app';
import { JobManager } from './jobs';
import { APP_VERSION, Runtime } from './runtime';
import { Store } from './store';

// Entry point: `npm run dev:server` (tsx), `npm run demo`, or `npm start` (bundled dist/server.mjs).

function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // no .env file: configuration comes from the real environment
  }
}

async function main(): Promise<void> {
  loadDotEnv();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  // Never expose an unauthenticated instance (with API keys behind it) beyond this machine by accident.
  if (!isLoopbackHost(config.host) && !config.appPassword && process.env.ALLOW_PUBLIC_WITHOUT_PASSWORD !== '1') {
    console.error(
      `\nОТКАЗ ЗА СТАРТ: HOST=${config.host} е достъпен от мрежата, но няма парола.\n` +
        `Всеки, който стигне до адреса, би използвал твоите API ключове.\n` +
        `Задай APP_PASSWORD в .env (или остави HOST=127.0.0.1). Ако пред приложението има друга защита (reverse proxy с вход),\n` +
        `можеш да зададеш ALLOW_PUBLIC_WITHOUT_PASSWORD=1.\n`,
    );
    process.exit(1);
  }

  const store = new Store(config.dataDir);
  await store.init();
  const runtime = new Runtime(config);
  const logger = { info: (m: string) => console.log(`[radar] ${m}`), error: (m: string, e?: unknown) => console.error(`[radar] ${m}`, e) };
  const jobs = new JobManager({ store, runtime, maxConcurrent: config.limits.maxConcurrentJobs, logger });

  const webRoot = resolve(process.cwd(), 'dist/web');
  const app = createApp({ runtime, store, jobs, webRoot });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    const status = runtime.status();
    const line = (ok: boolean, text: string): string => `  ${ok ? '✔' : '✘'} ${text}`;
    console.log(`\nJev SEO Radar ${APP_VERSION} е стартиран на http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${info.port}`);
    if (config.demo) console.log('  ▶ ДЕМО РЕЖИМ: всички данни са примерни и фиктивни, няма външни заявки.');
    console.log(line(status.jev.configured, config.demo ? 'Jev: демо (mock)' : status.jev.configured ? `Jev: ${status.jev.model} @ ${status.jev.host}` : 'Jev: НЕ Е НАСТРОЕН — задай JEV_API_KEY в .env'));
    console.log(line(status.serp.configured, config.demo ? 'SERP: демо' : status.serp.configured ? `SERP: ${status.serp.provider}` : 'SERP: няма доставчик — ще работи само ръчен режим (URL адреси). Добави SERPER_API_KEY за автоматично търсене.'));
    console.log(line(status.volume.configured, config.demo ? 'Търсения/мес: демо' : status.volume.configured ? 'Търсения/мес: DataForSEO' : 'Търсения/мес: няма източник (по желание: DataForSEO)'));
    console.log(line(config.appPassword !== null, config.appPassword ? 'Достъп: защитен с парола' : 'Достъп: без парола (само от този компютър)'));
    if (!existsSync(webRoot)) console.log('  ! Интерфейсът не е build-нат. За разработка ползвай „npm run dev“ (http://localhost:5173), за продукция „npm run build“.');
    console.log('');
  });

  const shutdown = (signal: string): void => {
    console.log(`\n[radar] ${signal} — изключвам…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
