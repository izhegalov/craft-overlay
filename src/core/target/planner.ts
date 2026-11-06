import type { ModifierGroup, ParsedItem } from '../types';
import type { EssenceMod, ModPool, PoolMod, Side, SpecialMod } from './modpool';
import { boneFor, sameBase, statTemplate, statValues } from './modpool';
import { finishUses, readSocketGoals, type SocketablesData } from './sockets';

/**
 * Можно ли докрафтить предмет до образца.
 *
 * Вероятности — симуляция Монте-Карло по весам модов: у стратегии есть
 * фиксированная политика, а результат — доля успешных попыток и средний расход.
 * Мод, который нельзя смоделировать, не делает образец недостижимым: он
 * выводится отдельно, а расчёт идёт по остальным. См. docs/TARGET-ITEMS.md.
 */

export interface PlannerOptions {
  pool: ModPool;
  /** Допуск к значению мода образца: 0.2 = не меньше 80% от значения. */
  tolerance: number;
  /** Цена единицы валюты в Exalted Orb по id. */
  prices: Record<string, number>;
  /** Названия валюты для вывода по id. */
  labels?: Record<string, string>;
  /** Цена новой заготовки в Exalted: столько стоит потерять предмет при неудаче. */
  basePrice?: number;
  /** Руны, ядра душ и идолы; без них вставки не считаются. */
  socketables?: SocketablesData;
  /** Вернуть все стратегии, а не три лучших: для сравнения в тестах. */
  allPaths?: boolean;
  trials?: number;
  seed?: number;
}

export interface TargetModStatus {
  text: string;
  kind: Side;
  /** Руна, ядро или идол: не занимает слот мода. */
  socket?: boolean;
  status: 'have' | 'need' | 'special' | 'impossible';
  note?: string;
}

export interface CurrencyUse {
  id: string;
  label: string;
  average: number;
  price: number | null;
}

export interface StrategyResult {
  id: string;
  label: string;
  probability: number;
  /** Точность: сколько попыток симулировано. */
  trials: number;
  costPerAttempt: number;
  /** Расход на один успех: валюта всех попыток и потерянные заготовки; null, если успехов нет. */
  costPerSuccess: number | null;
  /** Сколько заготовок уйдёт в среднем на один успех. */
  basesPerSuccess: number | null;
  /** Цена заготовки не задана: при шансе ниже 100% стоимость занижена. */
  basePriceMissing: boolean;
  /** Хотя бы одна цена неизвестна: стоимость занижена. */
  incompleteCost: boolean;
  uses: CurrencyUse[];
  /** Почему путь показан: самый дешёвый, самый вероятный или запасной. */
  tag?: string;
  steps: PlanStep[];
}

/** Шаг подсказки в оверлее. */
export interface PlanStep {
  title: string;
  detail?: string;
  /** Шаг повторяется, пока не выйдет. */
  repeat?: boolean;
  /** Средний шанс одного применения по весам модов, в ходе симуляции пути. */
  chance?: number;
  /** На что этот шанс. */
  chanceOf?: string;
}

/** Шаг до расчёта: stage связывает его с применениями в симуляции. */
type StepDraft = PlanStep & { stage?: string };

/** Какой предмет выгодно купить вместо белой базы. */
export interface BaseOption {
  mods: string[];
  rarity: 'magic' | 'rare';
  label: string;
  probability: number;
  /** Расход на успех без цены самой покупки. */
  cost: number;
  /** Дороже этой цены покупка не окупается; null, если сравнить не с чем. */
  maxPrice: number | null;
  incompleteCost: boolean;
}

export interface BaseAdvice {
  baseType: string;
  /** Минимальный уровень предмета для нужных тиров. */
  itemLevel: number;
  /** Моды, которые нельзя скрафтить: нужны уже на купленной базе. */
  mustHave: string[];
  /** Лучший путь с белой базы; null, если симуляция его не нашла. */
  white: { label: string; probability: number; cost: number; incompleteCost: boolean } | null;
  options: BaseOption[];
}

export type TargetVerdict = 'ready' | 'reachable' | 'partial' | 'unreachable';

export interface TargetReport {
  baseType: string;
  targetName: string;
  verdict: TargetVerdict;
  reasons: string[];
  mods: TargetModStatus[];
  strategies: StrategyResult[];
}

/** Результат проверки предмета для оверлея. */
export interface TargetCheck {
  error?: string;
  reports: TargetReport[];
  /** Цена Divine Orb в Exalted, для вывода крупных сумм. */
  divinePrice: number | null;
  pricesNote?: string;
  /** Расчёт ещё идёт. */
  pending?: boolean;
}

/** План, выбранный в оверлее: пройденные шаги сохраняются между запусками. */
export interface ActivePlan {
  targetName: string;
  label: string;
  steps: Array<PlanStep & { state: 'todo' | 'done' | 'failed'; attempts: number }>;
}

export const PATH_LIMIT = 3;

type OrbTier = 'greater' | 'perfect';

const ORB_IDS: Record<'exalt' | 'chaos' | 'regal' | 'aug' | 'transmute', Record<OrbTier | 'base', string>> = {
  exalt: { base: 'exalted', greater: 'greater-exalted-orb', perfect: 'perfect-exalted-orb' },
  chaos: { base: 'chaos', greater: 'greater-chaos-orb', perfect: 'perfect-chaos-orb' },
  regal: { base: 'regal', greater: 'greater-regal-orb', perfect: 'perfect-regal-orb' },
  aug: {
    base: 'aug',
    greater: 'greater-orb-of-augmentation',
    perfect: 'perfect-orb-of-augmentation',
  },
  transmute: {
    base: 'transmute',
    greater: 'greater-orb-of-transmutation',
    perfect: 'perfect-orb-of-transmutation',
  },
};

/** Минимальный уровень мода у больших и совершенных сфер, данные poe2db. */
const ORB_MIN_LEVEL: Record<keyof typeof ORB_IDS, Record<OrbTier | 'base', number>> = {
  exalt: { base: 0, greater: 35, perfect: 50 },
  chaos: { base: 0, greater: 35, perfect: 50 },
  regal: { base: 0, greater: 35, perfect: 50 },
  aug: { base: 0, greater: 44, perfect: 70 },
  transmute: { base: 0, greater: 44, perfect: 70 },
};

type ModSource = 'normal' | 'borrowed' | 'essence' | 'desecrated' | 'special' | 'unknown';

interface TargetMod {
  text: string;
  template: string;
  family: string | null;
  kind: Side;
  minimums: number[];
  source: ModSource;
  method?: string;
  /** Рост значения от качества, 1 — без качества. */
  quality: number;
}

interface Slot {
  kind: Side;
  family: string | null;
  /** Какая цель достигнута, -1 — нет. */
  target: number;
  /** Цель, которой мод может стать после Divine Orb, и шанс этого. */
  aim: number;
  chance: number;
  level: number;
  locked: boolean;
  desecrated: boolean;
}

/** Строка пула с шансом выпавшего значения пройти допуск цели. */
interface PlannedRow {
  mod: PoolMod;
  target: number;
  chance: number;
}

interface Strategy {
  id: string;
  label: string;
  sideOmen?: boolean;
  doubleExalt?: boolean;
  remove?: 'annul' | 'chaos';
  essence?: boolean;
  alchemy?: boolean;
  divine?: boolean;
  /** Большие или совершенные сферы: отсекают моды низкого уровня. */
  tier?: OrbTier;
  /** Хаос убирает мод самого низкого уровня. */
  whittling?: boolean;
  /** Закрепить мод Раскалывающей сферой, когда на предмете 4 мода. */
  fracture?: boolean;
}

interface Plan {
  targets: TargetMod[];
  /** Цели, которые считает симуляция. */
  active: number[];
  /** Сколько слотов держать свободными под особые моды. */
  reserved: Record<Side, number>;
  rows: PlannedRow[];
  essences: Map<number, { essence: EssenceMod; chance: number }>;
  /** Шанс получить нужный очернённый мод с одного очернения. */
  desecration: Map<number, { reveal: number; chance: number; omen?: string }>;
  bone: string;
}

interface Start {
  rarity: 'normal' | 'magic' | 'rare';
  slots: Slot[];
}

// Циклы идут почти до конца: их итог — сколько валюты нужно на доведение предмета.
const ONE_PASS_STEPS = 30;
const LOOP_STEPS = 300;
const LOOP_TRIALS = 120;
const ONE_PASS_TRIALS = 3000;
const REVEAL_OPTIONS = 3;

/** Накопленный шанс применений по этапам: сумма точных шансов, а не выпавших исходов. */
type StageOdds = Map<string, { casts: number; sum: number }>;

const CHANCE_OF: Record<string, string> = {
  alch: 'нужный мод, на каждый из 4',
  annul: 'снять лишний мод',
  divine: 'все значения в разбросе',
  fracture: 'закрепить нужный мод',
};

export const CURRENCY_LABELS: Record<string, string> = {
  transmute: 'Сфера превращения',
  aug: 'Сфера усиления',
  regal: 'Сфера царей',
  alch: 'Сфера алхимии',
  exalted: 'Сфера возвышения',
  chaos: 'Сфера хаоса',
  annul: 'Сфера отмены',
  divine: 'Божественная сфера',
  'omen-of-sinistral-exaltation': 'Омен: возвышение префикса',
  'omen-of-dextral-exaltation': 'Омен: возвышение суффикса',
  'omen-of-greater-exaltation': 'Омен: двойное возвышение',
  'omen-of-sinistral-annulment': 'Омен: отмена префикса',
  'omen-of-dextral-annulment': 'Омен: отмена суффикса',
  'omen-of-sinistral-erasure': 'Омен: хаос по префиксу',
  'omen-of-dextral-erasure': 'Омен: хаос по суффиксу',
  'omen-of-sinistral-crystallisation': 'Омен: сущность по префиксу',
  'omen-of-dextral-crystallisation': 'Омен: сущность по суффиксу',
  'omen-of-sinistral-necromancy': 'Омен: очернение префикса',
  'omen-of-dextral-necromancy': 'Омен: очернение суффикса',
  'omen-of-abyssal-echoes': 'Омен: повтор выбора очернения',
  'omen-of-light': 'Омен: отмена очернённого мода',
  'omen-of-the-sovereign': 'Омен: очернение Уламана',
  'omen-of-the-liege': 'Омен: очернение Аманаму',
  'omen-of-the-blackblooded': 'Омен: очернение Каргала',
  'omen-of-whittling': 'Омен: хаос по самому слабому моду',
  'omen-of-sinistral-coronation': 'Омен: сфера царей в префикс',
  'omen-of-dextral-coronation': 'Омен: сфера царей в суффикс',
  'omen-of-sinistral-alchemy': 'Омен: алхимия с префиксами',
  'omen-of-dextral-alchemy': 'Омен: алхимия с суффиксами',
  'fracturing-orb': 'Раскалывающая сфера',
  'greater-exalted-orb': 'Большая сфера возвышения',
  'perfect-exalted-orb': 'Совершенная сфера возвышения',
  'greater-chaos-orb': 'Большая сфера хаоса',
  'perfect-chaos-orb': 'Совершенная сфера хаоса',
  'greater-regal-orb': 'Большая сфера царей',
  'perfect-regal-orb': 'Совершенная сфера царей',
  'greater-orb-of-augmentation': 'Большая сфера усиления',
  'perfect-orb-of-augmentation': 'Совершенная сфера усиления',
  'greater-orb-of-transmutation': 'Большая сфера превращения',
  'perfect-orb-of-transmutation': 'Совершенная сфера превращения',
  'preserved-collarbone': 'Сохранившаяся ключица',
  'preserved-jawbone': 'Сохранившаяся челюсть',
  'preserved-rib': 'Сохранившееся ребро',
  'preserved-cranium': 'Сохранившийся череп',
};

const BOSS_OMENS: Array<[RegExp, string]> = [
  [/уламан/i, 'omen-of-the-sovereign'],
  [/аманаму/i, 'omen-of-the-liege'],
  [/каргал/i, 'omen-of-the-blackblooded'],
];

const SIDE_OMEN: Record<
  'exalt' | 'annul' | 'chaos' | 'essence' | 'desecrate' | 'regal' | 'alchemy',
  Record<Side, string>
> = {
  regal: { prefix: 'omen-of-sinistral-coronation', suffix: 'omen-of-dextral-coronation' },
  alchemy: { prefix: 'omen-of-sinistral-alchemy', suffix: 'omen-of-dextral-alchemy' },
  exalt: { prefix: 'omen-of-sinistral-exaltation', suffix: 'omen-of-dextral-exaltation' },
  annul: { prefix: 'omen-of-sinistral-annulment', suffix: 'omen-of-dextral-annulment' },
  chaos: { prefix: 'omen-of-sinistral-erasure', suffix: 'omen-of-dextral-erasure' },
  essence: {
    prefix: 'omen-of-sinistral-crystallisation',
    suffix: 'omen-of-dextral-crystallisation',
  },
  desecrate: { prefix: 'omen-of-sinistral-necromancy', suffix: 'omen-of-dextral-necromancy' },
};

/** Детерминированный ГСЧ (mulberry32): одинаковый результат при повторном нажатии. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function explicitGroups(item: ParsedItem): ModifierGroup[] {
  return item.modifiers.filter(
    (group) => group.source === 'explicit' && (group.kind === 'prefix' || group.kind === 'suffix'),
  );
}

/** Качество катализатором видно в аннотации: «40% увеличение». */
function qualityOf(group: ModifierGroup): number {
  const percent = group.annotation?.match(/(\d+)%/)?.[1];
  return percent ? 1 + Number(percent) / 100 : 1;
}

interface Identified {
  row?: PoolMod | SpecialMod;
  source: ModSource;
  line: string;
}

/** Окончание имени аффикса зависит от рода предмета: «Оккультный» и «Оккультное». */
function stem(name: string): string {
  return name.toLowerCase().slice(0, -2);
}

/**
 * Находит мод в списке: по имени, затем по тексту и значению.
 * shortcut: у гибридов в mods-data.json есть только первая строка, вторая
 * не сверяется; нужен полный источник модов.
 */
function findRow<T extends PoolMod>(
  list: T[],
  group: ModifierGroup,
  lines: string[],
  values: number[],
): T | undefined {
  const templates = lines.map(statTemplate);
  const candidates = list.filter(
    (mod) => mod.kind === group.kind && templates.includes(mod.template),
  );
  const affix = group.affixName;
  return (
    (affix ? candidates.find((mod) => stem(mod.name) === stem(affix)) : undefined) ??
    candidates.find((mod) =>
      mod.ranges.every(([low, high], index) => {
        const value = values[index] ?? 0;
        return value >= low && value <= high;
      }),
    ) ??
    candidates[0]
  );
}

function identify(group: ModifierGroup, pool: ModPool): Identified {
  const lines = group.lines.map((line) => line.text);
  const quality = qualityOf(group);
  const firstValues = statValues(lines[0] ?? '').map((value) => value / quality);

  const sources: Array<[ModSource, PoolMod[]]> = group.states.includes('desecrated')
    ? [['desecrated', pool.desecrated]]
    : group.states.includes('crafted')
      ? [['essence', pool.essences], ['special', pool.special]]
      : [
          ['normal', pool.mods],
          ['essence', pool.essences],
          ['desecrated', pool.desecrated],
          ['special', pool.special],
          ['borrowed', pool.borrowed],
        ];

  for (const [source, list] of sources) {
    const row = findRow(list, group, lines, firstValues);
    if (row) {
      const line = lines.find((text) => statTemplate(text) === row.template) ?? lines[0] ?? '';
      return { row, source, line };
    }
  }
  return { source: 'unknown', line: lines[0] ?? '' };
}

/** Цели образца. Текст без advanced-заголовков (market) ищем по шаблонам пула. */
export function readTargetMods(target: ParsedItem, pool: ModPool, tolerance: number): TargetMod[] {
  const minimums = (line: string, quality: number): number[] =>
    statValues(line).map((value) => (value / quality) * (1 - tolerance));

  const mods: TargetMod[] = explicitGroups(target).map((group) => {
    const { row, source, line } = identify(group, pool);
    const quality = qualityOf(group);
    return {
      text: group.lines.map((entry) => entry.text).join(' / '),
      template: statTemplate(line),
      family: row?.family ?? null,
      kind: group.kind as Side,
      minimums: minimums(line, quality),
      source,
      quality,
      ...(row && 'method' in row ? { method: row.method } : {}),
    };
  });

  const lists: Array<[ModSource, PoolMod[]]> = [
    ['normal', pool.mods],
    ['essence', pool.essences],
    ['desecrated', pool.desecrated],
    ['special', pool.special],
    ['borrowed', pool.borrowed],
  ];
  for (const line of target.unknownLines) {
    const template = statTemplate(line);
    for (const [source, list] of lists) {
      const row = list.find((mod) => mod.template === template);
      if (!row) continue;
      mods.push({
        text: line,
        template,
        family: row.family,
        kind: row.kind,
        minimums: minimums(line, 1),
        source,
        quality: 1,
        ...('method' in row ? { method: (row as SpecialMod).method } : {}),
      });
      break;
    }
  }
  return mods;
}

/** Шанс, что равномерный ролл мода не ниже порогов цели. */
function rollChance(mod: Pick<PoolMod, 'ranges'>, minimums: number[]): number {
  if (mod.ranges.length !== minimums.length) return 0;
  return mod.ranges.reduce((chance, [low, high], index) => {
    const minimum = minimums[index] ?? 0;
    if (minimum <= low) return chance;
    if (minimum > high) return 0;
    return chance * ((high - minimum) / (high - low));
  }, 1);
}

function matchesTarget(mod: PoolMod, target: TargetMod): boolean {
  return (
    mod.kind === target.kind &&
    mod.template === target.template &&
    (target.source === 'borrowed' || mod.family === target.family)
  );
}

function poolRows(target: TargetMod, pool: ModPool): PoolMod[] {
  if (target.source === 'desecrated') return pool.desecrated;
  if (target.source === 'essence') return pool.essences;
  return target.source === 'borrowed' ? pool.borrowed : pool.mods;
}

/** Значение выше всех тиров (данные устарели): цель — лучший тир, а не «нельзя». */
function capMinimums(target: TargetMod, rows: PoolMod[]): boolean {
  const matching = rows.filter((mod) => matchesTarget(mod, target));
  if (matching.length === 0 || matching.some((mod) => rollChance(mod, target.minimums) > 0)) {
    return false;
  }
  const best = matching.reduce((top, mod) =>
    (mod.ranges[0]?.[1] ?? 0) > (top.ranges[0]?.[1] ?? 0) ? mod : top,
  );
  target.minimums = target.minimums.map((value, index) =>
    Math.min(value, best.ranges[index]?.[0] ?? value),
  );
  return true;
}

function buildPlan(
  targets: TargetMod[],
  active: number[],
  reserved: Plan['reserved'],
  pool: ModPool,
  itemLevel: number,
  bone: string,
  bossOmens: boolean,
): Plan {
  const obtainable = (mod: PoolMod): boolean => mod.level <= itemLevel;
  const rowFor = (mod: PoolMod): PlannedRow => {
    const target = active.find((index) => {
      const entry = targets[index];
      return entry !== undefined && matchesTarget(mod, entry);
    });
    if (target === undefined) return { mod, target: -1, chance: 0 };
    const chance = rollChance(mod, targets[target]?.minimums ?? []);
    return { mod, target: chance > 0 ? target : -1, chance };
  };

  const borrowed = active.flatMap((index) => {
    const entry = targets[index];
    if (entry?.source !== 'borrowed') return [];
    return pool.borrowed.filter((mod) => obtainable(mod) && matchesTarget(mod, entry));
  });
  const rows = [...pool.mods.filter(obtainable), ...borrowed].map(rowFor);

  const essences: Plan['essences'] = new Map();
  const desecration: Plan['desecration'] = new Map();
  for (const index of active) {
    const target = targets[index];
    if (!target) continue;
    for (const essence of pool.essences) {
      if (essence.template !== target.template || essence.kind !== target.kind) continue;
      if (essence.level > itemLevel) continue;
      const chance = rollChance(essence, target.minimums);
      if (chance > (essences.get(index)?.chance ?? 0)) essences.set(index, { essence, chance });
    }

    if (target.source === 'desecrated') {
      const allOnSide = pool.desecrated.filter(
        (mod) => mod.kind === target.kind && obtainable(mod),
      );
      const hits = allOnSide.filter((mod) => matchesTarget(mod, target));
      // Боссовый омен сужает варианты до модов одного босса: только оружие и бижутерия.
      const boss = bossOmens
        ? BOSS_OMENS.find(([pattern]) => hits.some((mod) => pattern.test(mod.name)))
        : undefined;
      const side = boss ? allOnSide.filter((mod) => boss[0].test(mod.name)) : allOnSide;
      const share = hits.filter((mod) => side.includes(mod)).length / Math.max(1, side.length);
      const chance = hits.reduce(
        (best, mod) => Math.max(best, rollChance(mod, target.minimums)),
        0,
      );
      // Выбор из трёх вариантов, омен даёт второй показ.
      const options = 1 - (1 - share) ** REVEAL_OPTIONS;
      desecration.set(index, {
        reveal: 1 - (1 - options) ** 2,
        chance,
        ...(boss ? { omen: boss[1] } : {}),
      });
    }
  }

  return { targets, active, reserved, rows, essences, desecration, bone };
}

function meetsTarget(group: ModifierGroup, target: TargetMod, pool: ModPool): boolean {
  const { row, line } = identify(group, pool);
  const sameMod =
    group.kind === target.kind &&
    statTemplate(line) === target.template &&
    (!row || !target.family || row.family === target.family);
  if (!sameMod) return false;
  const quality = qualityOf(group);
  const values = statValues(line).map((value) => value / quality);
  return (
    values.length === target.minimums.length &&
    target.minimums.every((minimum, index) => (values[index] ?? 0) >= minimum)
  );
}

function readStart(item: ParsedItem, targets: TargetMod[], pool: ModPool): Start {
  const used = new Set<number>();
  const slots = explicitGroups(item).map((group): Slot => {
    const { row } = identify(group, pool);
    const target = targets.findIndex(
      (entry, index) => !used.has(index) && meetsTarget(group, entry, pool),
    );
    if (target >= 0) used.add(target);

    // Правильный тир с низким роллом: его можно вытянуть Divine Orb.
    const aim =
      row && target < 0
        ? targets.findIndex((entry, index) => !used.has(index) && matchesTarget(row, entry))
        : -1;
    const chance = row && aim >= 0 ? rollChance(row, targets[aim]?.minimums ?? []) : 0;

    return {
      kind: group.kind as Side,
      family: row?.family ?? null,
      target,
      aim: target >= 0 ? target : chance > 0 ? aim : -1,
      chance: target >= 0 ? 1 : chance,
      level: row?.level ?? 1,
      locked: group.states.includes('fractured'),
      desecrated: group.states.includes('desecrated'),
    };
  });
  const rarity = item.rarity === 'rare' || item.rarity === 'magic' ? item.rarity : 'normal';
  return { rarity, slots };
}

function capacity(rarity: Start['rarity']): number {
  if (rarity === 'rare') return 3;
  return rarity === 'magic' ? 1 : 0;
}

function runAttempt(
  plan: Plan,
  start: Start,
  strategy: Strategy,
  random: () => number,
  uses: Map<string, number>,
  odds: StageOdds,
): boolean {
  const slots = start.slots.map((slot) => ({ ...slot }));
  let rarity = start.rarity;

  const spend = (id: string): void => {
    uses.set(id, (uses.get(id) ?? 0) + 1);
  };
  const note = (stage: string, chance: number): void => {
    const entry = odds.get(stage);
    if (entry) {
      entry.casts += 1;
      entry.sum += chance;
    } else {
      odds.set(stage, { casts: 1, sum: chance });
    }
  };
  const open = (side: Side): number =>
    capacity(rarity) - slots.filter((slot) => slot.kind === side).length;
  const missing = (): number[] =>
    plan.active.filter((index) => !slots.some((slot) => slot.target === index));
  const sourceOf = (index: number): ModSource | undefined => plan.targets[index]?.source;

  const tier = strategy.tier ?? 'base';
  const orb = (kind: keyof typeof ORB_IDS): { id: string; minLevel: number } => ({
    id: ORB_IDS[kind][tier],
    minLevel: ORB_MIN_LEVEL[kind][tier],
  });

  const addRandom = (side: Side | undefined, minLevel: number, stage: string): boolean => {
    // Самый горячий участок симуляции: без выделения памяти на каждый выбор.
    const free = (kind: Side): boolean => open(kind) > plan.reserved[kind];
    const prefixOpen = side ? side === 'prefix' : free('prefix');
    const suffixOpen = side ? side === 'suffix' : free('suffix');
    const allowed = (row: PlannedRow): boolean =>
      (row.mod.kind === 'prefix' ? prefixOpen : suffixOpen) &&
      row.mod.level >= minLevel &&
      !slots.some((slot) => slot.family === row.mod.family);

    let total = 0;
    let wanted = 0;
    for (const row of plan.rows) {
      if (!allowed(row)) continue;
      total += row.mod.weight;
      if (row.target >= 0 && !slots.some((slot) => slot.target === row.target)) {
        wanted += row.mod.weight * row.chance;
      }
    }
    if (total <= 0) return false;
    note(stage, wanted / total);

    let roll = random() * total;
    let picked: PlannedRow | undefined;
    for (const row of plan.rows) {
      if (!allowed(row)) continue;
      picked = row;
      roll -= row.mod.weight;
      if (roll < 0) break;
    }
    if (!picked) return false;

    const fresh = picked.target >= 0 && !slots.some((slot) => slot.target === picked?.target);
    const hit = fresh && random() < picked.chance;
    slots.push({
      kind: picked.mod.kind,
      family: picked.mod.family,
      target: hit ? picked.target : -1,
      aim: fresh ? picked.target : -1,
      chance: fresh ? picked.chance : 0,
      level: picked.mod.level,
      locked: false,
      desecrated: false,
    });
    return true;
  };

  const removeRandom = (side?: Side, lowest = false, stage?: string): boolean => {
    const candidates = slots.filter((slot) => !slot.locked && (!side || slot.kind === side));
    if (stage && candidates.length > 0) {
      note(stage, candidates.filter((slot) => slot.target < 0).length / candidates.length);
    }
    const picked = lowest
      ? candidates.reduce<Slot | undefined>(
          (low, slot) => (!low || slot.level < low.level ? slot : low),
          undefined,
        )
      : candidates[Math.floor(random() * candidates.length)];
    if (!picked) return false;
    slots.splice(slots.indexOf(picked), 1);
    return true;
  };

  const addEssence = (target: number, essence: EssenceMod, chance: number): void => {
    spend(essence.priceId);
    note('essence', chance);
    const hit = random() < chance;
    slots.push({
      kind: essence.kind,
      family: essence.family,
      target: hit ? target : -1,
      aim: target,
      chance,
      level: essence.level,
      locked: false,
      desecrated: false,
    });
  };

  const desecrate = (target: number): boolean => {
    const entry = plan.targets[target];
    const option = plan.desecration.get(target);
    if (!entry || !option) return false;

    const old = slots.find((slot) => slot.desecrated);
    if (old) {
      spend('annul');
      spend('omen-of-light');
      slots.splice(slots.indexOf(old), 1);
    }
    spend(plan.bone);
    spend(SIDE_OMEN.desecrate[entry.kind]);
    spend('omen-of-abyssal-echoes');
    if (option.omen) spend(option.omen);
    if (open(entry.kind) <= 0 && !removeRandom(entry.kind)) return false;

    note('desecrate', option.reveal * option.chance);
    const found = random() < option.reveal;
    const hit = found && random() < option.chance;
    slots.push({
      kind: entry.kind,
      family: found ? entry.family : null,
      target: hit ? target : -1,
      aim: found ? target : -1,
      chance: found ? option.chance : 0,
      level: 65,
      locked: false,
      desecrated: true,
    });
    return true;
  };

  if (rarity === 'normal' && strategy.alchemy) {
    spend('alch');
    rarity = 'rare';
    const side = plan.targets[missing()[0] ?? -1]?.kind;
    if (side && strategy.sideOmen) {
      spend(SIDE_OMEN.alchemy[side]);
      for (let index = 0; index < 3; index += 1) addRandom(side, 0, 'alch');
    }
    while (slots.length < 4 && addRandom(undefined, 0, 'alch'));
  }

  const maxSteps = strategy.remove || strategy.divine ? LOOP_STEPS : ONE_PASS_STEPS;
  for (let step = 0; step < maxSteps; step += 1) {
    const left = missing();
    if (left.length === 0) return true;

    if (rarity === 'normal') {
      const { id, minLevel } = orb('transmute');
      spend(id);
      rarity = 'magic';
      addRandom(undefined, minLevel, 'transmute');
      continue;
    }

    if (rarity === 'magic') {
      const essenceTarget = strategy.essence
        ? left.find((index) => {
            const option = plan.essences.get(index);
            return option && !option.essence.perfect;
          })
        : undefined;
      const option = essenceTarget === undefined ? undefined : plan.essences.get(essenceTarget);
      if (slots.length < 2 && !option) {
        const { id, minLevel } = orb('aug');
        spend(id);
        addRandom(undefined, minLevel, 'aug');
        continue;
      }
      rarity = 'rare';
      if (essenceTarget !== undefined && option) {
        addEssence(essenceTarget, option.essence, option.chance);
      } else {
        const { id, minLevel } = orb('regal');
        spend(id);
        const side = plan.targets[left[0] ?? -1]?.kind;
        if (side && strategy.sideOmen) spend(SIDE_OMEN.regal[side]);
        addRandom(strategy.sideOmen ? side : undefined, minLevel, 'regal');
      }
      continue;
    }

    if (strategy.fracture && slots.length >= 4 && !slots.some((slot) => slot.locked)) {
      spend('fracturing-orb');
      note('fracture', slots.filter((slot) => slot.target >= 0).length / slots.length);
      const picked = slots[Math.floor(random() * slots.length)];
      if (picked) picked.locked = true;
      continue;
    }

    // Divine перебрасывает значения всех модов, поэтому только когда все цели в нужном тире.
    if (strategy.divine && left.every((index) => slots.some((slot) => slot.aim === index))) {
      spend('divine');
      note('divine', slots.reduce((all, slot) => (slot.aim >= 0 ? all * slot.chance : all), 1));
      for (const slot of slots) {
        if (slot.aim >= 0) slot.target = random() < slot.chance ? slot.aim : -1;
      }
      continue;
    }

    if (strategy.essence) {
      const perfectTarget = left.find((index) => plan.essences.get(index)?.essence.perfect);
      const option = perfectTarget === undefined ? undefined : plan.essences.get(perfectTarget);
      if (perfectTarget !== undefined && option && removeRandom(option.essence.kind)) {
        spend(SIDE_OMEN.essence[option.essence.kind]);
        addEssence(perfectTarget, option.essence, option.chance);
        continue;
      }
    }

    const rolled = left.filter(
      (index) => sourceOf(index) === 'normal' || sourceOf(index) === 'borrowed',
    );
    const desecrated = left.find((index) => sourceOf(index) === 'desecrated');
    if (rolled.length === 0 && desecrated !== undefined) {
      if (!desecrate(desecrated)) return false;
      continue;
    }

    const need = (side: Side): number =>
      left.filter((index) => plan.targets[index]?.kind === side).length + plan.reserved[side];
    // Слабый мод того же семейства тоже мешает: второй такой мод не выпадет.
    const conflict = (side: Side): boolean =>
      left.some(
        (index) =>
          plan.targets[index]?.kind === side &&
          slots.some((slot) => slot.target < 0 && slot.family === plan.targets[index]?.family),
      );
    const blocked = (['prefix', 'suffix'] as const).find(
      (side) => need(side) > open(side) || conflict(side),
    );

    if (blocked) {
      if (!strategy.remove) return false;
      const removable = slots.some(
        (slot) => slot.kind === blocked && !slot.locked && slot.target < 0,
      );
      if (!removable) return false;
      const side = strategy.sideOmen ? blocked : undefined;
      if (side) spend(SIDE_OMEN[strategy.remove][side]);
      if (strategy.whittling) spend('omen-of-whittling');
      const chaos = orb('chaos');
      spend(strategy.remove === 'chaos' ? chaos.id : 'annul');
      const annulStage = strategy.remove === 'annul' ? 'annul' : undefined;
      if (!removeRandom(side, strategy.whittling, annulStage)) return false;
      if (strategy.remove === 'chaos') addRandom(undefined, chaos.minLevel, 'chaos');
      continue;
    }

    if (rolled.length === 0) return false;

    const exalt = orb('exalt');
    spend(exalt.id);
    if (strategy.doubleExalt) {
      spend('omen-of-greater-exaltation');
      addRandom(undefined, exalt.minLevel, 'exalt');
      if (!addRandom(undefined, exalt.minLevel, 'exalt')) return false;
      continue;
    }
    const first = plan.targets[rolled[0] ?? -1]?.kind ?? 'prefix';
    if (strategy.sideOmen) spend(SIDE_OMEN.exalt[first]);
    const side = strategy.sideOmen ? first : undefined;
    if (!addRandom(side, exalt.minLevel, side ? `exalt-${side}` : 'exalt')) return false;
  }
  return false;
}

function runStrategy(
  plan: Plan,
  start: Start,
  strategy: Strategy,
  options: PlannerOptions,
  finish: CurrencyUse[],
  steps: StepDraft[],
): StrategyResult {
  const loops = strategy.remove !== undefined || strategy.divine === true;
  const trials = options.trials ?? (loops ? LOOP_TRIALS : ONE_PASS_TRIALS);
  const random = createRandom(options.seed ?? 1);
  const uses = new Map<string, number>();
  const odds: StageOdds = new Map();

  let successes = 0;
  for (let trial = 0; trial < trials; trial += 1) {
    if (runAttempt(plan, start, strategy, random, uses, odds)) successes += 1;
  }

  const labels = { ...CURRENCY_LABELS, ...options.labels };
  const list: CurrencyUse[] = [...uses].map(([id, count]) => ({
    id,
    label: labels[id] ?? id,
    average: count / trials,
    price: options.prices[id] ?? null,
  }));
  const costPerAttempt = list.reduce((sum, use) => sum + use.average * (use.price ?? 0), 0);
  const finishCost = finish.reduce((sum, use) => sum + use.average * (use.price ?? 0), 0);
  const probability = successes / trials;

  return {
    id: strategy.id,
    label: strategy.label,
    probability,
    trials,
    costPerAttempt,
    // Заготовка в руках уже есть: платим только за те, что потеряны при неудачах.
    costPerSuccess:
      successes > 0
        ? (costPerAttempt + (options.basePrice ?? 0) * (1 - probability)) / probability + finishCost
        : null,
    basesPerSuccess: successes > 0 ? 1 / probability : null,
    basePriceMissing: options.basePrice === undefined && probability < 1,
    incompleteCost: [...list, ...finish].some((use) => use.price === null),
    uses: [...list, ...finish],
    steps: steps.map(({ stage, ...step }) => {
      const seen = stage ? odds.get(stage) : undefined;
      if (!stage || !seen) return step;
      return { ...step, chance: seen.sum / seen.casts, chanceOf: CHANCE_OF[stage] ?? 'нужный мод' };
    }),
  };
}

function strategiesFor(start: Start, plan: Plan, missingCount: number): Strategy[] {
  const list: Strategy[] = [
    { id: 'exalt', label: 'Возвышение в открытые слоты' },
    { id: 'exalt-omen', label: 'Возвышение + омен стороны', sideOmen: true },
    { id: 'exalt-greater', label: 'Большие сферы + омен стороны', sideOmen: true, tier: 'greater' },
    { id: 'exalt-perfect', label: 'Совершенные сферы + омен стороны', sideOmen: true, tier: 'perfect' },
    { id: 'exalt-divine', label: 'Возвышение + божественная сфера', divine: true },
    {
      id: 'annul-loop',
      label: 'Цикл отмена → возвышение с оменами',
      sideOmen: true,
      remove: 'annul',
    },
    { id: 'annul-plain', label: 'Цикл отмена → возвышение без оменов', remove: 'annul' },
    {
      id: 'annul-loop-perfect',
      label: 'Цикл отмена → совершенное возвышение',
      sideOmen: true,
      remove: 'annul',
      tier: 'perfect',
    },
    {
      id: 'fracture-annul',
      label: 'Раскол, затем цикл отмены',
      sideOmen: true,
      remove: 'annul',
      fracture: true,
    },
    { id: 'chaos-loop', label: 'Цикл хаоса', remove: 'chaos' },
    { id: 'chaos-whittling', label: 'Цикл хаоса с оменом по слабому моду', remove: 'chaos', whittling: true },
    { id: 'chaos-perfect', label: 'Цикл совершенного хаоса', remove: 'chaos', tier: 'perfect' },
    { id: 'chaos-omen-loop', label: 'Цикл хаоса с оменом стирания', sideOmen: true, remove: 'chaos' },
  ];
  if (missingCount >= 2) {
    list.push({ id: 'double-exalt', label: 'Двойное возвышение (омен)', doubleExalt: true });
  }
  // Неподходящая редкость отсеется сама: у такой стратегии не будет успехов.
  if (plan.essences.size > 0) {
    list.push({
      id: 'essence',
      label: 'Сущность + отмена → возвышение',
      essence: true,
      sideOmen: true,
      remove: 'annul',
    });
  }
  if (start.rarity === 'normal') {
    list.push({ id: 'alchemy', label: 'Сфера алхимии + цикл отмены', alchemy: true, sideOmen: true, remove: 'annul' });
  }
  return list;
}

function displayName(target: ParsedItem): string {
  return target.name ?? target.baseType ?? target.itemClass;
}

/** Три пути: самый дешёвый, самый вероятный и следующий по цене. */
export function selectPaths(strategies: StrategyResult[]): StrategyResult[] {
  const working = strategies.filter((strategy) => strategy.costPerSuccess !== null);
  const byCost = [...working].sort((a, b) => (a.costPerSuccess ?? 0) - (b.costPerSuccess ?? 0));
  const byChance = [...working].sort((a, b) => b.probability - a.probability);

  const picked: StrategyResult[] = [];
  const add = (strategy: StrategyResult | undefined, tag: string): void => {
    if (strategy && !picked.includes(strategy)) picked.push({ ...strategy, tag });
  };
  add(byCost[0], 'Дешевле всего');
  if (byChance[0]?.id !== picked[0]?.id) add(byChance[0], 'Выше шанс');
  for (const strategy of byCost) {
    if (picked.length >= PATH_LIMIT) break;
    if (!picked.some((entry) => entry.id === strategy.id)) add(strategy, 'Запасной вариант');
  }
  return picked;
}

function useLabel(id: string, labels: Record<string, string>): string {
  return labels[id] ?? CURRENCY_LABELS[id] ?? id;
}

function buildSteps(
  strategy: Strategy,
  start: Start,
  mods: TargetModStatus[],
  plan: Plan,
  finish: CurrencyUse[],
  labels: Record<string, string>,
): StepDraft[] {
  const steps: StepDraft[] = [];
  const name = (id: string): string => useLabel(id, labels);
  const tier = strategy.tier ?? 'base';
  const needed = mods.filter((mod) => mod.status === 'need' && !mod.socket);
  const goal = (kind?: Side): string =>
    needed
      .filter((mod) => !kind || mod.kind === kind)
      .map((mod) => mod.text)
      .join('; ');

  if (start.rarity === 'normal') {
    if (strategy.alchemy) {
      steps.push({ title: name('alch'), detail: 'Сделать предмет редким сразу с 4 модами.', stage: 'alch' });
    } else {
      steps.push({ title: name(ORB_IDS.transmute[tier]), detail: 'Сделать предмет волшебным.', stage: 'transmute' });
    }
  }
  if (start.rarity !== 'rare' && !strategy.alchemy) {
    steps.push({ title: name(ORB_IDS.aug[tier]), detail: 'Добавить второй мод, если есть место.', stage: 'aug' });
    const essence = strategy.essence
      ? [...plan.essences.values()].find((option) => !option.essence.perfect)
      : undefined;
    steps.push(
      essence
        ? { title: essence.essence.name, detail: 'Сделать предмет редким с гарантированным модом.', stage: 'essence' }
        : { title: name(ORB_IDS.regal[tier]), detail: 'Сделать предмет редким.', stage: 'regal' },
    );
  }

  if (strategy.essence) {
    for (const { essence } of plan.essences.values()) {
      if (essence.perfect) {
        steps.push({
          title: `${essence.name} + ${name(SIDE_OMEN.essence[essence.kind])}`,
          detail: `Заменяет случайный мод на: ${essence.text}`,
          stage: 'essence',
        });
      }
    }
  }
  if (strategy.fracture) {
    steps.push({
      title: name('fracturing-orb'),
      detail: 'На предмете с 4 модами: закрепляет случайный мод. Лучше применять, когда хорошие моды в большинстве.',
      stage: 'fracture',
    });
  }

  const exalt = name(ORB_IDS.exalt[tier]);
  for (const side of ['prefix', 'suffix'] as const) {
    const wanted = goal(side);
    if (!wanted) continue;
    const omen = strategy.sideOmen ? ` + ${name(SIDE_OMEN.exalt[side])}` : '';
    steps.push({
      title: `${exalt}${omen}`,
      detail: `Цель: ${wanted}`,
      repeat: true,
      stage: strategy.sideOmen ? `exalt-${side}` : 'exalt',
    });
  }

  if (strategy.remove) {
    const remover =
      strategy.remove === 'chaos'
        ? `${name(ORB_IDS.chaos[tier])}${strategy.whittling ? ` + ${name('omen-of-whittling')}` : ''}`
        : name('annul');
    steps.push({
      title: remover,
      detail: strategy.sideOmen
        ? 'Если на стороне нет места или выпал мусор: убрать мод с оменом стороны и вернуться к предыдущему шагу. Омен выбирает сторону, но мод на ней случайный, может уйти и нужный.'
        : 'Если нужной стороне не хватает места: мод снимается случайно с любой стороны, может уйти и нужный. Затем вернуться к предыдущему шагу.',
      repeat: true,
      stage: strategy.remove,
    });
  }

  for (const [index, option] of plan.desecration) {
    const entry = plan.targets[index];
    if (!entry) continue;
    const omens = [SIDE_OMEN.desecrate[entry.kind], 'omen-of-abyssal-echoes', option.omen]
      .filter((id): id is string => Boolean(id))
      .map(name)
      .join(', ');
    steps.push({
      title: `${name(plan.bone)}: очернение`,
      detail: `Активировать: ${omens}. В Колодце душ выбрать: ${entry.text}`,
      repeat: true,
      stage: 'desecrate',
    });
  }

  if (strategy.divine) {
    steps.push({
      title: name('divine'),
      detail: 'Когда все нужные моды в правильном тире: перебрасывать значения до разброса.',
      repeat: true,
      stage: 'divine',
    });
  }

  for (const use of finish) {
    steps.push({ title: `${use.label} × ${use.average}`, detail: 'Вставить или применить в конце, результат гарантирован.' });
  }
  steps.push({ title: 'Проверить предмет', detail: 'Навести курсор и нажать Alt+G.' });
  return steps;
}

const SOURCE_NOTES: Partial<Record<ModSource, string>> = {
  borrowed: 'вес взят из другого класса предметов',
  essence: 'только сущность',
  desecrated: 'очернение',
};

/** Предупреждение о ненадёжном весе: шанс такого мода приблизителен. */
function weightNote(target: TargetMod, pool: ModPool): string | undefined {
  if (target.source !== 'normal') return undefined;
  const rows = pool.mods.filter((mod) => matchesTarget(mod, target));
  if (rows.some((mod) => mod.estimated)) return 'вес оценён по другому классу';
  return rows.length > 0 && rows.every((mod) => mod.weight <= 1) ? 'вес неизвестен, шанс условный' : undefined;
}

/** Что мешает смоделировать мод. null — мод считается симуляцией. */
function blocker(
  target: TargetMod,
  pool: ModPool,
  itemLevel: number,
  desecrationTaken: boolean,
  canDesecrate: boolean,
): Pick<TargetModStatus, 'status' | 'note'> | null {
  if (target.source === 'unknown') {
    return { status: 'special', note: 'мода нет в данных, расчёт без него' };
  }
  if (target.source === 'special') {
    return { status: 'special', note: `источник: ${target.method ?? 'особый'}, расчёт без него` };
  }
  if (target.source === 'desecrated' && (!canDesecrate || desecrationTaken)) {
    return {
      status: 'special',
      note: canDesecrate ? 'второй очернённый мод невозможен, расчёт без него' : 'предмет не очерняется',
    };
  }

  const reachable = poolRows(target, pool).filter(
    (mod) => matchesTarget(mod, target) || (target.source === 'essence' && mod.template === target.template),
  );
  const levels = reachable
    .filter((mod) => rollChance(mod, target.minimums) > 0)
    .map((mod) => mod.level);
  if (levels.length > 0 && Math.min(...levels) > itemLevel) {
    return { status: 'impossible', note: `нужен уровень предмета ${Math.min(...levels)}` };
  }
  return null;
}

/** Шанс цели с одной сферы и оменом стороны, по всем модам этой стороны. */
function omenShare(plan: Plan, index: number): number {
  const kind = plan.targets[index]?.kind;
  const side = plan.rows.filter((row) => row.mod.kind === kind);
  const total = side.reduce((sum, row) => sum + row.mod.weight, 0);
  const hit = side
    .filter((row) => row.target === index)
    .reduce((sum, row) => sum + row.mod.weight * row.chance, 0);
  return total > 0 ? hit / total : 0;
}

/** Предмет с готовыми модами. shortcut: лишних модов на нём нет, рынок редко даёт такие редкие. */
function boughtStart(mods: number[], targets: TargetMod[], pool: ModPool): Start {
  const slots = mods.flatMap((index): Slot[] => {
    const entry = targets[index];
    if (!entry) return [];
    const row = poolRows(entry, pool).find(
      (mod) => matchesTarget(mod, entry) && rollChance(mod, entry.minimums) > 0,
    );
    return [
      {
        kind: entry.kind,
        family: entry.family,
        target: index,
        aim: index,
        chance: 1,
        level: row?.level ?? 1,
        locked: false,
        desecrated: false,
      },
    ];
  });
  const prefixes = slots.filter((slot) => slot.kind === 'prefix').length;
  const suffixes = slots.length - prefixes;
  if (slots.length === 0) return { rarity: 'normal', slots };
  return { rarity: prefixes <= 1 && suffixes <= 1 ? 'magic' : 'rare', slots };
}

function wantedText(entry: TargetMod): string {
  const minimum = entry.minimums.map((value) => Math.ceil(value)).join(' / ');
  return `${entry.text} (от ${minimum})`;
}

/**
 * Какую базу купить под образец. Цены готовых предметов неизвестны, поэтому
 * показывается предел: дороже него покупка хуже крафта с белой базы.
 */
export function suggestBases(target: ParsedItem, options: PlannerOptions): BaseAdvice {
  const { pool } = options;
  const itemLevel = target.itemLevel ?? 100;
  const targets = readTargetMods(target, pool, options.tolerance);
  for (const entry of targets) capMinimums(entry, poolRows(entry, pool));

  const canDesecrate = boneFor(target) !== null;
  const reserved: Plan['reserved'] = { prefix: 0, suffix: 0 };
  const active: number[] = [];
  const mustHave: string[] = [];
  let desecrationTaken = false;
  targets.forEach((entry, index) => {
    const blocked = blocker(entry, pool, itemLevel, desecrationTaken, canDesecrate);
    if (blocked) {
      mustHave.push(wantedText(entry));
      if (blocked.status === 'special') reserved[entry.kind] += 1;
      return;
    }
    if (entry.source === 'desecrated') desecrationTaken = true;
    active.push(index);
  });

  const levelFor = (entry: TargetMod): number =>
    Math.min(
      ...poolRows(entry, pool)
        .filter((mod) => matchesTarget(mod, entry) && rollChance(mod, entry.minimums) > 0)
        .map((mod) => mod.level),
    );
  const requiredLevel = Math.max(
    1,
    ...active.map((index) => levelFor(targets[index] as TargetMod)).filter(Number.isFinite),
  );

  const bossOmens = target.category === 'weapon' || target.category === 'jewellery';
  const plan = buildPlan(targets, active, reserved, pool, itemLevel, boneFor(target) ?? '', bossOmens);
  const run = (start: Start): StrategyResult[] =>
    strategiesFor(start, plan, active.length - start.slots.length)
      .map((strategy) => runStrategy(plan, start, strategy, options, [], []))
      .filter((result) => result.probability > 0);

  const whiteRuns = run(boughtStart([], targets, pool));
  const total = (result: StrategyResult): number =>
    (result.costPerAttempt + (options.basePrice ?? 0)) / result.probability;
  const white = whiteRuns.reduce<StrategyResult | undefined>(
    (best, result) => (!best || total(result) < total(best) ? result : best),
    undefined,
  );
  const whiteTotal = white ? total(white) : null;

  // Покупать есть смысл то, что сложнее всего выкрафтить.
  const hardest = active
    .filter((index) => ['normal', 'borrowed'].includes(targets[index]?.source ?? ''))
    .sort((a, b) => omenShare(plan, a) - omenShare(plan, b));
  const firstOn = (side: Side): number[] =>
    hardest.filter((index) => targets[index]?.kind === side).slice(0, 1);
  const sets = [firstOn('prefix'), firstOn('suffix'), [...firstOn('prefix'), ...firstOn('suffix')], hardest.slice(0, 3)]
    .filter((set) => set.length > 0 && set.length < active.length);
  const unique = [...new Map(sets.map((set) => [[...set].sort().join(','), set])).values()];

  const baseOptions = unique.flatMap((set): BaseOption[] => {
    const start = boughtStart(set, targets, pool);
    const limit = (result: StrategyResult): number =>
      whiteTotal === null
        ? -result.costPerAttempt / result.probability
        : result.probability * whiteTotal - result.costPerAttempt;
    const best = run(start).reduce<StrategyResult | undefined>(
      (top, result) => (!top || limit(result) > limit(top) ? result : top),
      undefined,
    );
    if (!best || start.rarity === 'normal') return [];
    const maxPrice = whiteTotal === null || best.incompleteCost ? null : limit(best);
    if (maxPrice !== null && maxPrice <= 0) return [];
    return [
      {
        mods: set.map((index) => wantedText(targets[index] as TargetMod)),
        rarity: start.rarity,
        label: best.label,
        probability: best.probability,
        cost: best.costPerAttempt / best.probability,
        maxPrice,
        incompleteCost: best.incompleteCost,
      },
    ];
  });

  return {
    baseType: target.baseType ?? '',
    itemLevel: requiredLevel,
    mustHave,
    white: white
      ? {
          label: white.label,
          probability: white.probability,
          cost: white.costPerAttempt / white.probability,
          incompleteCost: white.incompleteCost,
        }
      : null,
    options: baseOptions.sort((a, b) => (b.maxPrice ?? 0) - (a.maxPrice ?? 0) || a.cost - b.cost),
  };
}

export function analyzeTarget(
  item: ParsedItem,
  target: ParsedItem,
  options: PlannerOptions,
): TargetReport {
  const baseType = target.baseType ?? '';
  const report: TargetReport = {
    baseType,
    targetName: displayName(target),
    verdict: 'unreachable',
    reasons: [],
    mods: [],
    strategies: [],
  };

  if (!sameBase(item, baseType)) {
    report.reasons.push(`Другая база: нужна «${baseType}».`);
    return report;
  }
  if (item.flags.corrupted || item.flags.doubleCorrupted || item.flags.mirrored) {
    report.reasons.push('Осквернённый или отзеркаленный предмет нельзя изменить.');
    return report;
  }
  if (item.rarity !== 'normal' && item.rarity !== 'magic' && item.rarity !== 'rare') {
    report.reasons.push('Докрафт считается для белых, волшебных и редких предметов.');
    return report;
  }

  const { pool } = options;
  const itemLevel = item.itemLevel ?? 100;
  const targets = readTargetMods(target, pool, options.tolerance);
  if (targets.length === 0) {
    report.reasons.push('В образце нет явных модов.');
    return report;
  }

  const capped = targets.map((entry) => capMinimums(entry, poolRows(entry, pool)));
  const start = readStart(item, targets, pool);
  const have = targets.map((_entry, index) => start.slots.some((slot) => slot.target === index));
  const canDesecrate = boneFor(target) !== null;

  let desecrationTaken = start.slots.some((slot) => slot.desecrated && slot.target >= 0);
  const reserved: Plan['reserved'] = { prefix: 0, suffix: 0 };
  const active: number[] = [];

  report.mods = targets.map((entry, index) => {
    const base = { text: entry.text, kind: entry.kind };
    if (have[index]) {
      active.push(index);
      return { ...base, status: 'have' as const };
    }
    const blocked = blocker(entry, pool, itemLevel, desecrationTaken, canDesecrate);
    if (blocked) {
      if (blocked.status === 'special') reserved[entry.kind] += 1;
      return { ...base, ...blocked };
    }
    if (entry.source === 'desecrated') desecrationTaken = true;
    active.push(index);
    const notes = [
      SOURCE_NOTES[entry.source],
      weightNote(entry, pool),
      capped[index] ? 'значение выше данных, взят лучший тир' : undefined,
      entry.quality > 1 ? `значение с качеством ${Math.round((entry.quality - 1) * 100)}%` : undefined,
    ].filter(Boolean);
    return { ...base, status: 'need' as const, ...(notes.length > 0 ? { note: notes.join(', ') } : {}) };
  });

  const socketables = options.socketables ?? { items: [] };
  const goals = readSocketGoals(target, item, socketables, options.tolerance, options.prices);
  report.mods.push(
    ...goals.map((goal) => ({
      text: goal.text,
      kind: 'prefix' as const,
      status: goal.status,
      socket: true,
      note:
        goal.status === 'special'
          ? 'вставка не опознана, расчёт без неё'
          : goal.use
            ? `вставить: ${goal.use.name} × ${goal.use.count}`
            : 'вставка',
    })),
  );

  const labels = { ...CURRENCY_LABELS, ...options.labels };
  const finish: CurrencyUse[] = finishUses(target, item, goals).map((use) => ({
    id: use.id,
    label: use.label,
    average: use.count,
    price: options.prices[use.id] ?? null,
  }));

  const corrupted = target.modifiers.filter((group) => group.source === 'corrupted');
  if (corrupted.length > 0) {
    report.reasons.push('Улучшение от осквернения образца не считается: результат Сферы ваал случаен и закрывает предмет.');
  }

  const skipped = report.mods.filter((mod) => mod.status === 'special' || mod.status === 'impossible');
  if (skipped.length > 0) {
    report.reasons.push(`Без этих модов: ${skipped.map((mod) => `${mod.text} (${mod.note})`).join('; ')}.`);
  }

  const missingCount = active.filter((index) => !have[index]).length;
  if (missingCount === 0) {
    if (finish.length > 0) {
      const steps = finish.map((use) => ({ title: `${use.label} × ${use.average}` }));
      report.verdict = skipped.length > 0 ? 'partial' : 'reachable';
      report.strategies = [
        {
          id: 'finish',
          label: 'Только вставки',
          tag: 'Гарантированно',
          probability: 1,
          trials: 1,
          costPerAttempt: 0,
          costPerSuccess: finish.reduce((sum, use) => sum + use.average * (use.price ?? 0), 0),
          basesPerSuccess: 1,
          basePriceMissing: false,
          incompleteCost: finish.some((use) => use.price === null),
          uses: finish,
          steps,
        },
      ];
      return report;
    }
    report.verdict = skipped.length > 0 ? 'partial' : 'ready';
    if (skipped.length === 0) report.reasons.push('Предмет уже подходит под образец с учётом допуска.');
    return report;
  }

  const bossOmens = target.category === 'weapon' || target.category === 'jewellery';
  const plan = buildPlan(targets, active, reserved, pool, itemLevel, boneFor(target) ?? '', bossOmens);

  // Шанс одной сферы виден, даже если целиком предмет симуляция не собрала.
  report.mods.forEach((mod, index) => {
    if (mod.socket || mod.status !== 'need' || !active.includes(index)) return;
    const share = omenShare(plan, index);
    if (share > 0) {
      const percent = `с оменом стороны ${(share * 100).toFixed(2)}%`;
      mod.note = mod.note ? `${percent}, ${mod.note}` : percent;
    }
  });

  const results = strategiesFor(start, plan, missingCount).map((strategy) =>
    runStrategy(plan, start, strategy, options, finish, buildSteps(strategy, start, report.mods, plan, finish, labels)),
  );
  report.strategies = options.allPaths ? results : selectPaths(results);

  const worked = report.strategies.some((strategy) => strategy.probability > 0);
  report.verdict = worked && skipped.length === 0 ? 'reachable' : 'partial';
  if (!worked) {
    report.reasons.push('Симуляция не дошла до образца: шанс слишком мал или мешают закреплённые моды. Попробуй больший разброс.');
  }
  return report;
}
