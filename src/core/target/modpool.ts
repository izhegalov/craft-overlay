import type { ParsedItem } from '../types';

/** Формат data/reference/mods-data.json. */
export interface ModsData {
  classes: Array<{
    key: string;
    sections: Array<{
      key: string;
      title?: string;
      groups: Array<{
        rows: Array<{ n: string; lvl: number; g: string; w: number; d: string; f: string }>;
      }>;
    }>;
  }>;
}

export type Side = 'prefix' | 'suffix';

export interface PoolMod {
  name: string;
  level: number;
  kind: Side;
  weight: number;
  text: string;
  family: string;
  template: string;
  ranges: Array<[number, number]>;
}

export interface EssenceMod extends PoolMod {
  /** Совершенная сущность, сплав, жидкая эмоция: на редком предмете заменяют случайный мод. */
  perfect: boolean;
  /** id на poe.ninja. */
  priceId: string;
}

export interface SpecialMod extends PoolMod {
  /** Откуда мод берётся: раздел базы модов. */
  method: string;
}

export interface ModPool {
  key: string;
  mods: PoolMod[];
  essences: EssenceMod[];
  desecrated: PoolMod[];
  /** Моды особых источников: правила их выпадения неизвестны, в симуляцию не входят. */
  special: SpecialMod[];
  /** Обычные моды других классов: запасной источник весов, если в классе мода нет. */
  borrowed: PoolMod[];
}

const RANGE = String.raw`\(-?\d[\d.,]*[–—-]-?\d[\d.,]*\)`;
const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const VALUE_RE = new RegExp(`${NUMBER}${RANGE}|${RANGE}|${NUMBER}`, 'g');

/** Текст мода без чисел: одинаков у строки игры и строки базы модов. */
export function statTemplate(text: string): string {
  return text
    .replace(VALUE_RE, '#')
    .replace(/\s*(?:<br\s*\/?>|\n)\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toLowerCase();
}

/** Числа строки игры после разбора: роллы без диапазонов. */
export function statValues(text: string): number[] {
  return (text.match(new RegExp(NUMBER, 'g')) ?? []).map((value) =>
    Number.parseFloat(value.replace(',', '.')),
  );
}

function rowRanges(text: string): Array<[number, number]> {
  return (text.match(VALUE_RE) ?? []).map((value) => {
    const numbers = (value.match(/-?\d+(?:[.,]\d+)?/g) ?? []).map((part) =>
      Math.abs(Number.parseFloat(part.replace(',', '.'))),
    );
    const low = numbers[0] ?? 0;
    const high = numbers[1] ?? low;
    return [Math.min(low, high), Math.max(low, high)];
  });
}

const COMMON_SECTIONS = new Set([
  'normal',
  'corrupted',
  'desecrated',
  'essence',
  'perfect_essence',
  'liquid',
]);

const SLOT_KEYS: Record<string, string> = {
  amulet: 'Amulets',
  ring: 'Rings',
  belt: 'Belts',
  buckler: 'Bucklers',
  focus: 'Foci',
  quiver: 'Quivers',
  bow: 'Bows',
  crossbow: 'Crossbows',
  oneHandMace: 'One_Hand_Maces',
  quarterstaff: 'Quarterstaves',
  sceptre: 'Sceptres',
  spear: 'Spears',
  staff: 'Staves',
  wand: 'Wands',
};

const ARMOUR_KEYS: Record<string, string> = {
  bodyArmour: 'Body_Armours',
  helmet: 'Helmets',
  gloves: 'Gloves',
  boots: 'Boots',
  shield: 'Shields',
};

const JEWEL_KEYS: Record<string, string> = {
  Алмаз: 'Diamond',
  Изумруд: 'Emerald',
  Рубин: 'Ruby',
  Сапфир: 'Sapphire',
};

/** Ключ класса в mods-data.json; null, если для слота нет данных. */
export function poolKey(item: ParsedItem): string | null {
  if (item.category === 'jewel') return JEWEL_KEYS[item.baseType ?? ''] ?? null;

  const subtype = item.subtype ?? '';
  const armourKey = ARMOUR_KEYS[subtype];
  if (!armourKey) return SLOT_KEYS[subtype] ?? null;

  const has = (key: string): boolean => item.properties.some((entry) => entry.key === key);
  const stats = [has('armour') && 'str', has('evasion') && 'dex', has('energyShield') && 'int'];
  const suffix = stats.filter(Boolean).join('_');
  return suffix ? `${armourKey}_${suffix}` : null;
}

type Row = ModsData['classes'][number]['sections'][number]['groups'][number]['rows'][number];

function toPoolMod(row: Row): PoolMod {
  return {
    name: row.n,
    level: row.lvl,
    kind: row.g === 'suffix' ? 'suffix' : 'prefix',
    weight: row.w,
    text: row.d,
    family: row.f,
    template: statTemplate(row.d),
    ranges: rowRanges(row.d),
  };
}

function essencePriceId(name: string, ruToEn: Record<string, string>): string {
  return (ruToEn[name] ?? name).toLowerCase().replace(/[^\p{L}]+/gu, '-');
}

export function buildPool(
  data: ModsData,
  key: string,
  ruToEn: Record<string, string>,
): ModPool | null {
  const source = data.classes.find((entry) => entry.key === key);
  if (!source) return null;

  const rows = (sectionKey: string): PoolMod[] =>
    (source.sections.find((section) => section.key === sectionKey)?.groups ?? [])
      .flatMap((group) => group.rows)
      .filter((row) => row.g === 'prefix' || row.g === 'suffix')
      .map(toPoolMod);

  const specialSections = source.sections.filter(
    (section) => !COMMON_SECTIONS.has(section.key),
  );
  // Один мод встречается во многих классах: без дедупликации его вес умножится.
  const borrowed = [
    ...new Map(
      data.classes
        .filter((entry) => entry.key !== key)
        .flatMap((entry) => entry.sections.filter((section) => section.key === 'normal'))
        .flatMap((section) => section.groups.flatMap((group) => group.rows))
        .filter((row) => row.w > 0 && (row.g === 'prefix' || row.g === 'suffix'))
        .map((row) => [[row.n, row.lvl, row.g, row.d].join('|'), toPoolMod(row)] as const),
    ).values(),
  ];

  const toEssence = (mod: PoolMod, perfect: boolean): EssenceMod => ({
    ...mod,
    perfect,
    priceId: essencePriceId(mod.name, ruToEn),
  });

  return {
    key,
    mods: rows('normal').filter((mod) => mod.weight > 0),
    essences: [
      ...rows('essence').map((mod) => toEssence(mod, false)),
      ...rows('perfect_essence').map((mod) => toEssence(mod, true)),
      ...rows('liquid').map((mod) => toEssence(mod, true)),
    ],
    desecrated: rows('desecrated'),
    special: specialSections.flatMap((section) =>
      rows(section.key).map((mod) => ({ ...mod, method: section.title ?? section.key })),
    ),
    borrowed,
  };
}

/** Кость для очернения по категории предмета; null, если предмет не очерняется. */
export function boneFor(item: ParsedItem): string | null {
  if (item.category === 'jewellery') return 'preserved-collarbone';
  if (item.category === 'jewel') return 'preserved-cranium';
  if (item.category === 'weapon' || item.subtype === 'quiver') return 'preserved-jawbone';
  return item.category === 'armour' || item.category === 'offhand' ? 'preserved-rib' : null;
}

/** База совпадает: у белого с качеством есть приставка, у волшебного она спрятана внутри имени. */
export function sameBase(item: ParsedItem, baseType: string): boolean {
  if (item.baseType) return item.baseType.replace(/^Образцов\S*\s+/, '') === baseType;
  return item.name?.includes(baseType) ?? false;
}
