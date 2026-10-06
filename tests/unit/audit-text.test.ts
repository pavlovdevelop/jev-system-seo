import { describe, expect, it } from 'vitest';
import { introProse, lenOf, normalizeForCompare } from '../../src/server/audit/text';

describe('lenOf', () => {
  it('counts what a reader sees, not UTF-16 units', () => {
    expect(lenOf('Уебсайт')).toBe(7);
    expect(lenOf('a😀b')).toBe(3); // one emoji is two UTF-16 units but one character
    expect(lenOf('')).toBe(0);
  });
});

describe('normalizeForCompare', () => {
  it('lower-cases, collapses whitespace and trims', () => {
    expect(normalizeForCompare('  Изработка   НА\nУебсайт ')).toBe('изработка на уебсайт');
  });

  it('treats missing text as empty', () => {
    expect(normalizeForCompare(null)).toBe('');
    expect(normalizeForCompare(undefined)).toBe('');
  });
});

describe('introProse', () => {
  const para1 = 'Изработваме уебсайтове за малък бизнес — от идея до готов сайт за две до три седмици.';
  const para2 = 'Всеки проект започва с разговор за целите ви и завършва с обучение как да го поддържате сами.';
  const para3 = 'Работим с WordPress, WooCommerce и собствени решения според нуждите на бизнеса.';

  it('skips the headings the extractor put into the intro and keeps the paragraphs', () => {
    const intro = ['Изработка на уебсайт', para1, 'Как работим', para2].join('\n');
    expect(introProse(intro, ['Изработка на уебсайт', 'Как работим'])).toBe(`${para1} ${para2}`);
  });

  it('compares headings without regard to case or spacing', () => {
    const heading = 'Цени   и пакети за изработка на уебсайт — сравнение на всички варианти с подробности';
    expect(heading.length).toBeGreaterThanOrEqual(40); // long enough that only the heading list can exclude it
    const intro = [heading, para1].join('\n');
    expect(introProse(intro, ['цени и ПАКЕТИ за изработка на уебсайт — сравнение на всички варианти с подробности'])).toBe(para1);
  });

  it('drops short blocks that are not in the heading list (menu items, buttons)', () => {
    const intro = ['Поискай оферта', para1, 'Прочети повече'].join('\n');
    expect(introProse(intro, [])).toBe(para1);
  });

  it('keeps only the first two paragraphs by default, and as many as asked otherwise', () => {
    const intro = [para1, para2, para3].join('\n');
    expect(introProse(intro, [])).toBe(`${para1} ${para2}`);
    expect(introProse(intro, [], 1)).toBe(para1);
    expect(introProse(intro, [], 3)).toBe(`${para1} ${para2} ${para3}`);
  });

  it('collapses the spacing inside a paragraph and splits on runs of line breaks', () => {
    expect(introProse(`${para1.replace(' — ', '   —\t')}\n\n\n${para2}`, [])).toBe(`${para1} ${para2}`);
  });

  it('returns an empty string when there is no prose at all', () => {
    expect(introProse('', [])).toBe('');
    expect(introProse('Меню\nКонтакти\nЗа нас', [])).toBe('');
    expect(introProse(para1, [para1])).toBe('');
  });

  it('ignores null headings', () => {
    expect(introProse(para1, [null, undefined])).toBe(para1);
  });
});
