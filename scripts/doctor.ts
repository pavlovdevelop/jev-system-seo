import { noul } from '@typesafe-ai/sdk';
import { ConfigError, describeJev, loadConfig } from '../src/server/config';
import { Jev, JevError, createSdkTransport, toJevError } from '../src/server/jev/client';
import { SerperProvider } from '../src/server/providers/serp/serper';
import { DataForSeoProvider } from '../src/server/providers/serp/dataforseo';
import { SerpError } from '../src/server/providers/serp/types';
import { MARKETS } from '../src/shared/markets';

// `npm run doctor` — checks that the keys in .env actually work, before you spend a whole analysis finding out.
//   npm run doctor            checks Jev
//   npm run doctor -- --serp  also runs one tiny SERP query (costs one search credit)

try {
  process.loadEnvFile('.env');
} catch {
  // no .env file
}

const ok = (m: string) => console.log(`  ✔ ${m}`);
const bad = (m: string) => console.log(`  ✘ ${m}`);

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env, []);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.log(`\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  console.log('\nJev SEO Radar — проверка на настройките\n');

  // ── Jev ──
  if (!config.jev) {
    bad('Jev: няма JEV_API_KEY в .env');
    process.exitCode = 1;
  } else {
    const d = describeJev(config.jev);
    console.log(`  Jev: ${d.flavor} · модел ${d.model} · ${d.host}`);
    const jev = new Jev({ transport: createSdkTransport(config.jev), model: config.jev.model, cacheSize: 0 });
    try {
      const t0 = Date.now();
      const { is_greeting } = await jev.ask('Здравей! Как си?', { is_greeting: noul('The text is a greeting.') });
      ok(`Jev отговаря за ${Date.now() - t0} ms (тест въпрос: вероятност за поздрав ${is_greeting.p.toFixed(2)}; очаква се висока)`);
      const usage = jev.stats();
      console.log(`    изразходвани входни токени: ${usage.inputTokens} (≈ $${usage.estimatedCostUsd.toFixed(6)})`);
    } catch (err) {
      const e = err instanceof JevError ? err : toJevError(err);
      bad(`Jev: ${e.message}`);
      if (e.kind === 'auth') console.log('    → Ключът е отхвърлен. Ако е от Vercel AI Gateway, започва с „vck_“. Ако е от TypeSafe — провери го в конзолата им.');
      process.exitCode = 1;
    }
  }

  // ── SERP ──
  if (!config.serp) {
    bad('SERP: няма доставчик (SERPER_API_KEY или DATAFORSEO_LOGIN/PASSWORD). Без него работи само ръчен режим.');
  } else if (!process.argv.includes('--serp')) {
    ok(`SERP: ${config.serp.provider} е настроен (не е тестван; добави „-- --serp“ за един пробен въпрос)`);
  } else {
    const provider = config.serp.provider === 'serper' ? new SerperProvider(config.serp.apiKey) : new DataForSeoProvider(config.serp.login, config.serp.password);
    try {
      const serp = await provider.search({ keyword: 'изработка на уебсайт', market: MARKETS.bg, depth: 10 });
      ok(`SERP (${config.serp.provider}): ${serp.results.length} резултата, напр. ${serp.results.slice(0, 3).map((r) => r.domain).join(', ')}`);
    } catch (err) {
      bad(`SERP: ${err instanceof SerpError || err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  }
  console.log(config.volume ? '  ✔ Търсения/мес: DataForSEO е настроен' : '  · Търсения/мес: не е настроен (по желание)');
  console.log('');
}

void main();
