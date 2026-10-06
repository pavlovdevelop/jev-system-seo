import { noul } from '@typesafe-ai/sdk';
import { ConfigError, describeJev, loadConfig } from '../src/server/config';
import { Jev, JevError, createSdkTransport, toJevError } from '../src/server/jev/client';
import { createEngines } from '../src/server/geo/engines';
import { EngineError, locationFor } from '../src/server/geo/engines/types';
import { SerperProvider } from '../src/server/providers/serp/serper';
import { DataForSeoProvider } from '../src/server/providers/serp/dataforseo';
import { SerpError } from '../src/server/providers/serp/types';
import { MARKETS } from '../src/shared/markets';

// `npm run doctor` — checks that the keys in .env actually work, before you spend a whole analysis finding out.
//   npm run doctor            checks Jev
//   npm run doctor -- --serp  also runs one tiny SERP query (costs one search credit)
//   npm run doctor -- --engines  checks the ChatGPT / Claude / Gemini keys with a tiny request each (a few tokens)
//   npm run doctor -- --engines --ask  also asks each of them one question with web search on (about a cent each)

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

  // ── AI assistants (GEO) ──
  const engines = createEngines(config.engines);
  if (engines.length === 0) {
    console.log('  · ИИ двигатели: няма ключове (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY). Без тях одитът на сайта работи, но не проверява какво казват ChatGPT, Claude и Gemini.');
  } else if (!process.argv.includes('--engines')) {
    ok(`ИИ двигатели: ${engines.map((e) => `${e.label} (${e.model})`).join(', ')} — не са тествани (добави „-- --engines“)`);
  } else {
    for (const engine of engines) {
      const t0 = Date.now();
      try {
        await engine.generate({ prompt: 'Reply with the single word: ok', maxTokens: 60 });
        ok(`${engine.label} (${engine.model}) отговаря за ${Date.now() - t0} ms`);
        if (process.argv.includes('--ask')) {
          const t1 = Date.now();
          const a = await engine.ask('Колко струва изработката на уебсайт за малка фирма в България?', { location: locationFor('bg') });
          ok(`${engine.label}: отговор с търсене за ${Date.now() - t1} ms — ${a.citations.length} цитирани източника${a.searched ? '' : ' (търсенето не е работило)'}`);
        }
      } catch (err) {
        bad(`${engine.label} (${engine.model}): ${err instanceof EngineError || err instanceof Error ? err.message : String(err)}`);
        if (err instanceof EngineError && err.kind === 'model') console.log(`    → Моделът не е намерен. Задай друг в ${engine.id === 'openai' ? 'OPENAI_MODEL' : engine.id === 'anthropic' ? 'ANTHROPIC_MODEL' : 'GEMINI_MODEL'}.`);
        process.exitCode = 1;
      }
    }
  }
  console.log('');
}

void main();
