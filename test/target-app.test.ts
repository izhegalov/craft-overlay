import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSettings, loadSettings, sanitizeSettings, saveSettings } from '../src/main/store';
import { checkItem, pricesAreStale, readTarget } from '../src/main/targets';

const helmet = readFileSync(new URL('../fixtures/ru/rare-helmet-advanced.txt', import.meta.url), 'utf8');
const boots = readFileSync(new URL('../fixtures/ru/rare-boots-advanced.txt', import.meta.url), 'utf8');

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'craft-overlay-')), 'settings.json');
}

describe('настройки', () => {
  it('сохраняются и читаются', () => {
    const path = tempFile();
    const settings = { ...defaultSettings(), tolerancePct: 35 };
    saveSettings(path, settings);
    expect(loadSettings(path)).toEqual(settings);
  });

  it('нет файла — значения по умолчанию', () => {
    expect(loadSettings(tempFile()).tolerancePct).toBe(20);
  });

  it('битый файл не теряется', () => {
    const path = tempFile();
    writeFileSync(path, '{ сломано');
    expect(loadSettings(path).targets).toEqual([]);
    expect(existsSync(`${path}.bad`)).toBe(true);
  });

  it('цена заготовки сохраняется только корректная', () => {
    const clean = sanitizeSettings({
      targets: [
        { id: 'a', text: 'x', basePrice: 10 },
        { id: 'b', text: 'y', basePrice: -1 },
        { id: 'c', text: 'z', basePrice: null },
      ],
    });
    expect(clean.targets).toEqual([
      { id: 'a', text: 'x', basePrice: 10 },
      { id: 'b', text: 'y' },
      { id: 'c', text: 'z' },
    ]);
  });

  it('значения из окна приводятся к допустимым', () => {
    const clean = sanitizeSettings({
      tolerancePct: 500,
      league: '  ',
      targets: [{ id: 1, text: 'x' }, { id: 'a', text: 'y' }],
      manualPrices: { exalted: -1, annul: 5, chaos: 'x' },
    });
    expect(clean.tolerancePct).toBe(100);
    expect(clean.league).toBe('Standard');
    expect(clean.targets).toHaveLength(1);
    expect(clean.manualPrices).toEqual({ annul: 5 });
  });
});

describe('план крафта', () => {
  it('план сохраняется, а мусор отбрасывается', () => {
    const plan = {
      targetName: 'Кольцо',
      label: 'Путь',
      steps: [
        { title: 'Шаг', detail: 'x', repeat: true, chance: 0.5, chanceOf: 'нужный мод', state: 'done', attempts: 2 },
        { title: 'Шаг 2', chance: 5 },
        { title: 5 },
      ],
    };
    const clean = sanitizeSettings({ activePlan: plan }).activePlan;
    expect(clean?.steps).toEqual([
      { title: 'Шаг', detail: 'x', repeat: true, chance: 0.5, chanceOf: 'нужный мод', state: 'done', attempts: 2 },
      { title: 'Шаг 2', state: 'todo', attempts: 0 },
    ]);
    expect(sanitizeSettings({ activePlan: { label: 1 } }).activePlan).toBeNull();
  });
});

describe('образцы и проверка', () => {
  it('отклоняет неподходящий образец с понятной причиной', () => {
    expect(readTarget('мусор')).toHaveProperty('error');
    const unique = readFileSync(new URL('../fixtures/ru/unique-amulet-advanced.txt', import.meta.url), 'utf8');
    expect(readTarget(unique)).toEqual({ error: 'Образцом может быть только редкий предмет.' });
  });

  it('предмет другой базы не сравнивается', () => {
    const settings = { ...defaultSettings(), targets: [{ id: 'a', text: helmet }] };
    expect(checkItem(boots, settings).error).toContain('нет целевых');
  });

  it('предмет сравнивается с образцом своей базы, ручная цена важнее загруженной', () => {
    const settings = {
      ...defaultSettings(),
      targets: [{ id: 'a', text: helmet }],
      manualPrices: { divine: 300 },
      prices: { league: 'Standard', fetchedAt: Date.now(), values: { divine: 500, exalted: 1 } },
    };
    const check = checkItem(helmet, settings);
    expect(check.divinePrice).toBe(300);
    expect(check.reports).toHaveLength(1);
  });

  it('цены устаревают при смене лиги и со временем', () => {
    const fresh = { league: 'Standard', fetchedAt: Date.now(), values: {} };
    expect(pricesAreStale({ ...defaultSettings(), prices: fresh })).toBe(false);
    expect(pricesAreStale({ ...defaultSettings(), prices: { ...fresh, league: 'Other' } })).toBe(true);
    expect(pricesAreStale({ ...defaultSettings(), prices: { ...fresh, fetchedAt: 0 } })).toBe(true);
    expect(pricesAreStale(defaultSettings())).toBe(true);
  });
});
