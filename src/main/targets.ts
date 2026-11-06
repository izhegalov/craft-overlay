import socketablesData from '../../data/socketables.json';
import { parseItemText } from '../core/parser';
import type { ParsedItem } from '../core/types';
import { sameBase, type ModPool } from '../core/target/modpool';
import {
  CURRENCY_LABELS,
  analyzeTarget,
  readTargetMods,
  suggestBases,
  type BaseAdvice,
  type TargetCheck,
} from '../core/target/planner';
import { poolFor } from '../core/target/pools';
import { NINJA_TYPES, parseNinjaOverview } from '../core/target/prices';
import type { SocketablesData } from '../core/target/sockets';
import type { Settings } from './store';

const PRICE_MAX_AGE_MS = 60 * 60 * 1000;
const PRICE_TIMEOUT_MS = 10000;

export interface TargetSummary {
  id: string;
  name: string;
  baseType: string;
  mods: string[];
  basePrice: number | null;
}

/** Разбирает образец. shortcut: образец только редкий, у волшебного база спрятана в имени. */
export function readTarget(text: string): { item: ParsedItem; pool: ModPool } | { error: string } {
  const { item } = parseItemText(text, 'ru');
  if (!item) return { error: 'Не удалось разобрать текст. Нужен русский текст предмета из игры или с маркета.' };
  if (item.rarity !== 'rare' || !item.baseType) return { error: 'Образцом может быть только редкий предмет.' };

  const pool = poolFor(item);
  if (!pool) return { error: `Для типа «${item.itemClass}» нет данных о модах.` };
  if (readTargetMods(item, pool, 0).length === 0) return { error: 'В образце не найдено явных модов.' };
  return { item, pool };
}

export function summarizeTarget(id: string, text: string, basePrice?: number): TargetSummary | null {
  const target = readTarget(text);
  if ('error' in target) return null;
  return {
    id,
    name: target.item.name ?? target.item.baseType ?? '',
    baseType: target.item.baseType ?? '',
    mods: readTargetMods(target.item, target.pool, 0).map((mod) => mod.text),
    basePrice: basePrice ?? null,
  };
}

export function effectivePrices(settings: Settings): Record<string, number> {
  return { ...settings.prices?.values, ...settings.manualPrices };
}

export function priceRows(settings: Settings): Array<{ id: string; label: string; price: number | null; manual: number | null }> {
  return Object.entries(CURRENCY_LABELS).map(([id, label]) => ({
    id,
    label,
    price: settings.prices?.values[id] ?? null,
    manual: settings.manualPrices[id] ?? null,
  }));
}

export function checkItem(text: string, settings: Settings): TargetCheck {
  const { item } = parseItemText(text, 'ru');
  if (!item) return { error: 'Не удалось разобрать предмет.', reports: [], divinePrice: null };

  const prices = effectivePrices(settings);
  const divinePrice = prices.divine ?? null;
  const reports = settings.targets.flatMap((saved) => {
    const target = readTarget(saved.text);
    if ('error' in target || !sameBase(item, target.item.baseType ?? '')) return [];
    const labels = Object.fromEntries(
      target.pool.essences.map((essence) => [essence.priceId, essence.name]),
    );
    return [
      analyzeTarget(item, target.item, {
        pool: target.pool,
        tolerance: settings.tolerancePct / 100,
        prices,
        ...(saved.basePrice !== undefined ? { basePrice: saved.basePrice } : {}),
        labels,
        socketables: socketablesData as SocketablesData,
      }),
    ];
  });

  return reports.length > 0
    ? { reports, divinePrice }
    : { error: 'Для этой базы нет целевых предметов. Добавь образец в настройках.', reports, divinePrice };
}

export function baseAdvice(id: string, settings: Settings): BaseAdvice | null {
  const saved = settings.targets.find((entry) => entry.id === id);
  const target = saved ? readTarget(saved.text) : null;
  if (!target || 'error' in target) return null;
  return suggestBases(target.item, {
    pool: target.pool,
    tolerance: settings.tolerancePct / 100,
    prices: effectivePrices(settings),
    ...(saved?.basePrice !== undefined ? { basePrice: saved.basePrice } : {}),
  });
}

export function pricesAreStale(settings: Settings): boolean {
  return (
    settings.prices?.league !== settings.league ||
    Date.now() - settings.prices.fetchedAt > PRICE_MAX_AGE_MS
  );
}

/** Загружает курсы с poe.ninja. Предметы туда не отправляются: только название лиги. */
export async function fetchPrices(league: string): Promise<NonNullable<Settings['prices']>> {
  const values: Record<string, number> = {};
  for (const type of NINJA_TYPES) {
    const url = `https://poe.ninja/poe2/api/economy/exchange/current/overview?league=${encodeURIComponent(league)}&type=${type}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'craft-overlay' },
      signal: AbortSignal.timeout(PRICE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`poe.ninja: HTTP ${response.status}`);
    Object.assign(values, parseNinjaOverview(await response.json()));
  }
  return { league, fetchedAt: Date.now(), values };
}
