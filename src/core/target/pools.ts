import enRuMap from '../../../data/reference/en-ru-map.json';
import modsData from '../../../data/reference/mods-data.json';
import type { ParsedItem } from '../types';
import { buildPool, poolKey, type ModPool, type ModsData } from './modpool';

const ruToEn = Object.fromEntries(
  Object.entries(enRuMap as Record<string, string>).map(([en, ru]) => [ru, en]),
);
const pools = new Map<string, ModPool | null>();

/** Пул модов предмета; null, если для слота нет данных. */
export function poolFor(item: ParsedItem): ModPool | null {
  const key = poolKey(item);
  if (!key) return null;
  if (!pools.has(key)) pools.set(key, buildPool(modsData as ModsData, key, ruToEn));
  return pools.get(key) ?? null;
}
