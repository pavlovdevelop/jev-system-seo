import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ENGINE_LABELS, type EngineId } from '../../shared/domain';
import { MARKET_IDS, MARKETS, type MarketId } from '../../shared/markets';
import type { StatusResponse } from '../../shared/schemas';
import { Callout, Icon, Loading } from '../components/ui';
import { api } from '../lib/api';
import { BRAND_NAME_MAX, BRAND_NAME_MIN, BRAND_NAMES_MAX, parseBrandNames } from '../lib/audit';
import { parseDomains } from '../lib/form';
import { useAsync } from '../lib/hooks';

const JEV_FLAVOR = {
  typesafe: 'TypeSafe API',
  vercel: 'Vercel AI Gateway',
  custom: 'собствен адрес',
  demo: 'имитация за демо',
  none: '—',
} as const;
const SERP_NAME = { serper: 'Serper', dataforseo: 'DataForSEO', demo: 'демо данни', none: 'не е настроен' } as const;
const ENGINE_KEY: Record<EngineId, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };

type Tone = 'ok' | 'missing' | 'optional';

/** Connection state is a status: always an icon plus words, never color alone. */
function Conn({ tone, children }: { tone: Tone; children: string }): JSX.Element {
  const cls = tone === 'ok' ? 'status-easy' : tone === 'missing' ? 'status-hard' : 'status-medium';
  const icon = tone === 'ok' ? 'check' : tone === 'missing' ? 'alert' : 'info';
  return (
    <span class={`status ${cls}`}>
      <Icon name={icon} size={16} />
      {children}
    </span>
  );
}

function Connections({ status }: { status: StatusResponse }): JSX.Element {
  const { jev, serp, volume, engines, writer } = status;
  return (
    <section class="card">
      <div class="card-head">
        <h2>Връзки</h2>
        <p>версия {status.version}</p>
      </div>
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Състояние на връзките</caption>
          <thead>
            <tr>
              <th scope="col">Какво</th>
              <th scope="col">Състояние</th>
              <th scope="col">Подробности</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><div class="cell-main">Jev (TypeSafe AI)</div><div class="cell-sub">оценява страниците и фразите</div></td>
              <td><Conn tone={jev.configured ? 'ok' : 'missing'}>{jev.configured ? 'свързан' : 'не е свързан'}</Conn></td>
              <td class="small muted">{jev.configured ? `${JEV_FLAVOR[jev.flavor]}${jev.model ? ` · ${jev.model}` : ''}${jev.host ? ` · ${jev.host}` : ''}` : 'Добави JEV_API_KEY (виж по-долу).'}</td>
            </tr>
            <tr>
              <td><div class="cell-main">SERP доставчик</div><div class="cell-sub">какво е на първа страница в Google</div></td>
              <td><Conn tone={serp.configured ? 'ok' : 'missing'}>{serp.configured ? 'свързан' : 'не е настроен'}</Conn></td>
              <td class="small muted">{serp.configured ? SERP_NAME[serp.provider] : 'Без него остава само ръчният режим с адреси на конкуренти.'}</td>
            </tr>
            <tr>
              <td><div class="cell-main">Месечни търсения</div><div class="cell-sub">обем на фразите</div></td>
              <td><Conn tone={volume.configured ? 'ok' : 'optional'}>{volume.configured ? 'свързан' : 'по избор'}</Conn></td>
              <td class="small muted">{volume.configured ? SERP_NAME[volume.provider] : 'Идва от DataForSEO. Без него подредбата ползва само слабостта на конкуренцията и търговската стойност.'}</td>
            </tr>
            <tr>
              <td><div class="cell-main">ИИ асистенти</div><div class="cell-sub">ChatGPT, Claude и Gemini — питаме ги какво казват за бизнеса</div></td>
              <td>
                <div class="au-lines">
                  {engines.map((e) => (
                    <div key={e.id}><Conn tone={e.configured ? 'ok' : 'optional'}>{`${ENGINE_LABELS[e.id]}: ${e.configured ? 'свързан' : 'не е свързан'}`}</Conn></div>
                  ))}
                  {engines.length === 0 ? <div><Conn tone="optional">по избор</Conn></div> : null}
                </div>
              </td>
              <td class="small muted">
                <div class="au-lines">
                  {engines.map((e) => (
                    <div key={e.id}>{e.configured ? (e.model ?? 'свързан') : `Добави ${ENGINE_KEY[e.id]} — по избор.`}</div>
                  ))}
                  {engines.length === 0 ? <div>Сървърът не съобщи кои асистенти са налични.</div> : null}
                </div>
              </td>
            </tr>
            <tr>
              <td><div class="cell-main">Автор на предложенията</div><div class="cell-sub">пише предложения и чеклисти</div></td>
              <td><Conn tone={writer.configured ? 'ok' : 'optional'}>{writer.configured ? 'свързан' : 'по избор'}</Conn></td>
              <td class="small muted">
                Пише предложения и чеклисти: {writer.configured && writer.engine ? ENGINE_LABELS[writer.engine] : 'фиксирани правила (без ИИ асистент)'}
              </td>
            </tr>
            <tr>
              <td><div class="cell-main">Достъп до приложението</div><div class="cell-sub">кой може да го отваря</div></td>
              <td><Conn tone={status.authRequired ? 'ok' : 'optional'}>{status.authRequired ? 'с парола' : 'без парола'}</Conn></td>
              <td class="small muted">{status.authRequired ? 'Браузърът пита за парола (APP_PASSWORD).' : 'Подходящо само ако сървърът слуша само на този компютър (HOST=127.0.0.1). Иначе задай APP_PASSWORD.'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SetupHelp({ status }: { status: StatusResponse }): JSX.Element {
  return (
    <section class="card">
      <div class="card-head">
        <h2>Как да свържеш Jev, SERP доставчик и ИИ асистенти</h2>
      </div>
      <Callout kind="info">
        Ключовете се пазят само във файла <code>.env</code> на сървъра. Този интерфейс никога не ги вижда, не ги записва и не ги връща — затова не се въвеждат тук.
      </Callout>
      <ol class="steps-how" style={{ marginTop: '16px' }}>
        <li>
          <div>
            Копирай <code>.env.example</code> като <code>.env</code> в папката на проекта и добави ключовете:
            <pre class="env" style={{ marginTop: '8px' }}>{`# Jev (TypeSafe AI) — задължително
JEV_API_KEY=ключът_ти
# Ключ от Vercel AI Gateway (започва с vck_) се разпознава сам.

# SERP доставчик — достатъчен е един
SERPER_API_KEY=ключът_ти
# или, ако искаш и месечни търсения:
DATAFORSEO_LOGIN=имейл
DATAFORSEO_PASSWORD=парола

# ИИ асистенти за „ИИ видимост“ — по избор, достатъчен е един
OPENAI_API_KEY=ключът_ти
ANTHROPIC_API_KEY=ключът_ти
GEMINI_API_KEY=ключът_ти

# По желание: парола за интерфейса
APP_PASSWORD=избери_парола`}</pre>
            <p class="small muted" style={{ marginTop: '8px' }}>
              Ключовете на ИИ асистентите са по избор: с тях одитът на целия сайт пита ChatGPT, Claude и Gemini какво казват за бизнеса ти. Един от тях пише и предложенията и чеклистите — без ключ те са по фиксирани правила.
            </p>
          </div>
        </li>
        <li>
          <div>Рестартирай сървъра (<code>npm start</code>), за да прочете файла.</div>
        </li>
        <li>
          <div>
            Провери връзките с <code>npm run doctor</code> — прави по една минимална заявка към всеки доставчик и казва какво не е наред, без да показва ключовете.
          </div>
        </li>
      </ol>
      {status.demo ? (
        <p class="small muted" style={{ marginTop: '14px' }}>
          Сега работиш в демо режим: данните са измислени и Jev е имитация. Стартирай без <code>--demo</code> и без <code>DEMO_MODE</code>, за да анализираш истински сайтове.
        </p>
      ) : null}
    </section>
  );
}

export function SettingsPage({ status }: { status: StatusResponse }): JSX.Element {
  const settings = useAsync(() => api.settings(), []);
  const [market, setMarket] = useState<MarketId>('bg');
  const [ownDomain, setOwnDomain] = useState('');
  const [description, setDescription] = useState('');
  const [brands, setBrands] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current || !settings.data) return;
    loaded.current = true;
    const s = settings.data.settings;
    setMarket(s.market);
    setOwnDomain(s.ownDomain ?? '');
    setDescription(s.businessDescription);
    setBrands(s.brandNames.join('\n'));
  }, [settings.data]);

  const save = async (e: Event): Promise<void> => {
    e.preventDefault();
    setProblem(null);
    setSaved(false);
    const parsed = ownDomain.trim() ? parseDomains(ownDomain) : { ok: [], bad: [] };
    if (parsed.bad.length > 0 || parsed.ok.length > 1) return setProblem('Домейнът трябва да е един, напр. mysite.bg.');
    const names = parseBrandNames(brands);
    if (names.error) return setProblem(names.error);
    setSaving(true);
    try {
      const { settings: next } = await api.saveSettings({ businessDescription: description.trim(), ownDomain: parsed.ok[0] ?? null, brandNames: names.names, market });
      setOwnDomain(next.ownDomain ?? '');
      setDescription(next.businessDescription);
      setBrands(next.brandNames.join('\n'));
      setSaved(true);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Неуспешно записване.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="stack-lg">
      <div class="page-head" style={{ marginBottom: 0 }}>
        <h1>Настройки</h1>
        <p class="page-sub">Профилът ти се подава на всеки нов анализ — така Jev знае за какъв бизнес отсява фразите.</p>
      </div>

      {settings.loading && !settings.data ? <Loading /> : null}
      {settings.error && !settings.data ? <Callout kind="error">{settings.error.message}</Callout> : null}

      {settings.data ? (
        <form class="card stack-lg" onSubmit={save} noValidate>
          <div class="card-head" style={{ marginBottom: 0 }}>
            <h2>Твоят бизнес</h2>
          </div>
          <div class="grid grid-2">
            <div class="field">
              <label class="label" for="s-own">Твоят домейн</label>
              <input id="s-own" class="input" type="text" inputMode="url" autoComplete="off" spellcheck={false} placeholder="mysite.bg" value={ownDomain} onInput={(e) => { setSaved(false); setOwnDomain(e.currentTarget.value); }} />
              <span class="hint">Отбелязва се в отчетите като „ти“ и се сравнява с конкурентите.</span>
            </div>
            <div class="field">
              <label class="label" for="s-market">Пазар по подразбиране</label>
              <select id="s-market" class="select" value={market} onChange={(e) => { setSaved(false); setMarket(e.currentTarget.value as MarketId); }}>
                {MARKET_IDS.map((id) => (
                  <option key={id} value={id}>{MARKETS[id].label}</option>
                ))}
              </select>
            </div>
          </div>
          <div class="field">
            <label class="label" for="s-desc">Какво предлага бизнесът ти</label>
            <textarea id="s-desc" class="textarea" rows={4} maxLength={600} placeholder="напр. Агенция в София, правим уебсайтове и онлайн магазини за малки и средни фирми." value={description} onInput={(e) => { setSaved(false); setDescription(e.currentTarget.value); }} />
            <span class="hint">1–2 изречения. Колкото по-конкретно, толкова по-точно Jev ще отсява свързаните фрази (остават {600 - description.length} знака).</span>
          </div>
          <div class="field">
            <label class="label" for="s-brands">Имена на марката</label>
            <textarea id="s-brands" class="textarea" rows={3} spellcheck={false} placeholder={'Моето студио\nMy Studio\nmy-studio.example'} value={brands} onInput={(e) => { setSaved(false); setBrands(e.currentTarget.value); }} />
            <span class="hint">
              Как ИИ може да нарича бизнеса ти — така разпознаваме споменаване. По едно име на ред ({BRAND_NAME_MIN}–{BRAND_NAME_MAX} знака, най-много {BRAND_NAMES_MAX}).
            </span>
          </div>
          {problem ? <Callout kind="error">{problem}</Callout> : null}
          <div class="row">
            <button type="submit" class="btn btn-primary" disabled={saving}>{saving ? 'Записвам…' : 'Запази'}</button>
            {saved ? <span class="status status-easy" role="status"><Icon name="check" size={16} />Записано</span> : null}
          </div>
        </form>
      ) : null}

      <Connections status={status} />
      <SetupHelp status={status} />
    </div>
  );
}
