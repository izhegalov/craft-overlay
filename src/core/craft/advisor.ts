import type { ModPool, Side } from '../target/modpool';
import { statTemplate } from '../target/modpool';
import type { ModifierGroup, ParsedItem } from '../types';

/**
 * Крафт-советник (пробный режим).
 *
 * Это НЕ оценка цены и не «ИИ-мнение»: правила по модам, семействам модов,
 * тирам и открытым слотам. Оценка не привязана к конкретному билду —
 * используются универсальные целевые семейства для слота/типа предмета.
 */

export type AdviceVerdict = 'good' | 'neutral' | 'bad' | 'unknown';

export type AdviceMode =
  | 'equipment'
  | 'flask'
  | 'jewel'
  | 'charm'
  | 'waystone'
  | 'tablet'
  | 'relic';

export type ModFamily =
  | 'skillLevels'
  | 'spellDamage'
  | 'physicalDamage'
  | 'addedDamage'
  | 'defencePercent'
  | 'defenceFlat'
  | 'life'
  | 'mana'
  | 'spirit'
  | 'resistance'
  | 'chaosResistance'
  | 'attributes'
  | 'movementSpeed'
  | 'attackSpeed'
  | 'castSpeed'
  | 'critChance'
  | 'critMulti'
  | 'esRecharge'
  | 'thorns'
  | 'stunThreshold'
  | 'ailmentDuration'
  | 'attributeRequirements'
  | 'lifeRegen'
  | 'flaskCharge'
  | 'flaskDuration'
  | 'flaskEffect'
  | 'charmEffect'
  | 'charmDuration'
  | 'quantity'
  | 'rarity'
  | 'packSize'
  | 'monsterEffectiveness'
  | 'waystoneDrop'
  | 'damage'
  | 'unknown';

export interface AdviceMod {
  kind: 'prefix' | 'suffix' | 'unknown';
  text: string;
  tier?: number;
  verdict: AdviceVerdict;
  reason: string;
}

export interface AdviceCounts {
  prefixes: number;
  suffixes: number;
  openPrefixes: number;
  openSuffixes: number;
  good: number;
  neutral: number;
  bad: number;
}

export interface CraftAdvice {
  supported: boolean;
  profile: string;
  summary: string;
  steps: string[];
  targetPrefixes: string[];
  targetSuffixes: string[];
  mods: AdviceMod[];
  counts: AdviceCounts;
  warnings: string[];
}

interface AdviceProfile {
  id: string;
  label: string;
  targetPrefixes: string[];
  targetSuffixes: string[];
  targetPrefixFamilies: ModFamily[];
  targetSuffixFamilies: ModFamily[];
  mode: AdviceMode;
}

interface FamilyRule {
  family: ModFamily;
  pattern: RegExp;
}

const FAMILY_RULES: FamilyRule[] = [
  // Статы приспешников и союзников не усиливают самого персонажа.
  { family: 'unknown', pattern: /^(приспешники|союзники|компаньоны)/i },
  { family: 'skillLevels', pattern: /к уровню (всех )?камней умений|к уровню .*камней умений/i },
  { family: 'spellDamage', pattern: /урона? от чар/i },
  // Шипы и «добавляет» раньше physicalDamage: оба текста содержат «физического урона».
  { family: 'thorns', pattern: /шипами/i },
  { family: 'addedDamage', pattern: /дополнительного урона|добавляет .*урона/i },
  { family: 'physicalDamage', pattern: /физического урона/i },
  {
    family: 'defencePercent',
    pattern: /(увеличение|повышение) (максимума )?(брони|уклонения|энергетического щита)/i,
  },
  {
    family: 'defenceFlat',
    pattern: /к (броне|уклонению|максимуму энергетического щита)/i,
  },
  {
    family: 'life',
    pattern: /к максимуму здоровья|увеличение максимума здоровья(?! компаньонов| подношений)/i,
  },
  { family: 'mana', pattern: /к максимуму маны|увеличение максимума маны/i },
  { family: 'spirit', pattern: /к духу|увеличение духа/i },
  { family: 'chaosResistance', pattern: /к (максимальному )?сопротивлению хаосу/i },
  {
    family: 'resistance',
    pattern:
      /к (максимальному )?сопротивлению (огню|холоду|молнии|всем стихиям)|к сопротивлениям|к максимуму сопротивлений/i,
  },
  { family: 'attributes', pattern: /ко? (силе|ловкости|интеллекту|всем характеристикам)/i },
  { family: 'movementSpeed', pattern: /скорости передвижения/i },
  { family: 'attackSpeed', pattern: /скорости атаки/i },
  { family: 'castSpeed', pattern: /скорости сотворения чар/i },
  { family: 'critChance', pattern: /шанса критического удара|шансу критического удара/i },
  {
    family: 'critMulti',
    pattern: /бонусу критического урона|бонуса к критическому урону(?! приспешников)/i,
  },
  { family: 'esRecharge', pattern: /(скорости|начала) перезарядки энергетического щита/i },
  { family: 'stunThreshold', pattern: /оглушени/i },
  { family: 'ailmentDuration', pattern: /длительности (кровотечения|отравления)/i },
  { family: 'attributeRequirements', pattern: /снижение требований к характеристикам/i },
  { family: 'lifeRegen', pattern: /регенерация .*здоровья/i },
  { family: 'flaskCharge', pattern: /зарядов|восполнения зарядов/i },
  // Длительность оберега раньше flaskDuration и charmEffect: иначе её текст перехватят они.
  { family: 'charmDuration', pattern: /длительности эффекта оберега/i },
  { family: 'flaskDuration', pattern: /длительности эффекта/i },
  { family: 'flaskEffect', pattern: /эффекта флакона|эффективности флакона/i },
  { family: 'charmEffect', pattern: /эффекта оберега|эффективности оберега/i },
  { family: 'quantity', pattern: /количества находимых предметов/i },
  { family: 'rarity', pattern: /редкости найденных предметов/i },
  { family: 'packSize', pattern: /размер групп монстров/i },
  { family: 'monsterEffectiveness', pattern: /эффективность монстров/i },
  { family: 'waystoneDrop', pattern: /выпадения путевого камня/i },
  { family: 'damage', pattern: /увеличение урона/i },
];

const BAD_FAMILIES = new Set<ModFamily>([
  'thorns',
  'stunThreshold',
  'ailmentDuration',
  'attributeRequirements',
  'lifeRegen',
]);

function familyOf(text: string): ModFamily {
  for (const rule of FAMILY_RULES) {
    if (rule.pattern.test(text)) return rule.family;
  }
  return 'unknown';
}

function unsupported(summary: string, warnings: string[] = []): CraftAdvice {
  return {
    supported: false,
    profile: 'Советник',
    summary,
    steps: [],
    targetPrefixes: [],
    targetSuffixes: [],
    mods: [],
    counts: {
      prefixes: 0,
      suffixes: 0,
      openPrefixes: 0,
      openSuffixes: 0,
      good: 0,
      neutral: 0,
      bad: 0,
    },
    warnings,
  };
}

function numericProperty(item: ParsedItem, key: string): number {
  const property = item.properties.find((entry) => entry.key === key);
  if (!property) return 0;
  const raw = property.values.join(' ').replace(',', '.');
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  return match ? Number.parseFloat(match[0]) : 0;
}

function groupText(group: ModifierGroup): string {
  return group.lines.map((line) => line.text).filter(Boolean).join(' / ') || group.headerRaw;
}

function defenceLabel(item: ParsedItem): string {
  const parts: string[] = [];
  if (numericProperty(item, 'energyShield') > 0) parts.push('ЭЩ');
  if (numericProperty(item, 'armour') > 0) parts.push('броня');
  if (numericProperty(item, 'evasion') > 0) parts.push('уклонение');
  return parts.length > 0 ? parts.join(' + ') : 'защита';
}

function equipmentProfile(
  item: ParsedItem,
  label: string,
  targetPrefixes: string[],
  targetSuffixes: string[],
  targetPrefixFamilies: ModFamily[],
  targetSuffixFamilies: ModFamily[],
): AdviceProfile {
  return {
    id: label,
    label,
    targetPrefixes,
    targetSuffixes,
    targetPrefixFamilies,
    targetSuffixFamilies,
    mode: 'equipment',
  };
}

function armourProfile(item: ParsedItem): AdviceProfile {
  const defence = defenceLabel(item);
  const slotLabel: Record<string, string> = {
    bodyArmour: 'Нательный доспех',
    helmet: 'Шлем',
    gloves: 'Перчатки',
    boots: 'Обувь',
    shield: 'Щит',
    buckler: 'Баклер',
  };
  const slot = slotLabel[item.subtype ?? ''] ?? item.itemClass;
  const prefixLabels = [
    `% повышение ${defence}`,
    `+N к ${defence}`,
    '+N к максимуму здоровья',
    '+N к духу',
  ];
  const prefixFamilies: ModFamily[] = ['defencePercent', 'defenceFlat', 'life', 'spirit'];
  const suffixLabels = [
    '+N% к сопротивлению огню / холоду / молнии',
    '+N% к сопротивлению хаосу',
    '+N к силе / ловкости / интеллекту',
  ];
  const suffixFamilies: ModFamily[] = ['resistance', 'chaosResistance', 'attributes'];

  if (item.subtype === 'boots') {
    suffixLabels.push('30–35% повышение скорости передвижения');
    suffixFamilies.push('movementSpeed');
  }
  if (item.subtype === 'gloves') {
    suffixLabels.push('скорость атаки / скорость сотворения чар');
    suffixFamilies.push('attackSpeed', 'castSpeed');
  }
  if (numericProperty(item, 'energyShield') > 0) {
    suffixLabels.push('повышение скорости перезарядки ЭЩ');
    suffixFamilies.push('esRecharge');
  }

  return equipmentProfile(
    item,
    `${slot} · ${defence}`,
    prefixLabels,
    suffixLabels,
    prefixFamilies,
    suffixFamilies,
  );
}

function weaponProfile(item: ParsedItem): AdviceProfile {
  const caster = item.subtype === 'wand' || item.subtype === 'staff' || item.subtype === 'sceptre';
  if (caster) {
    return equipmentProfile(
      item,
      `${item.itemClass} · кастер`,
      [
        '% увеличение урона от чар',
        '+N к максимуму маны',
        '+N к духу',
        'добавляет урон от чар / элемента',
      ],
      [
        'скорость сотворения чар',
        'шанс критического удара',
        'бонус критического урона',
        '+N к уровню всех камней умений',
      ],
      ['spellDamage', 'mana', 'spirit', 'addedDamage'],
      ['castSpeed', 'critChance', 'critMulti', 'skillLevels'],
    );
  }
  return equipmentProfile(
    item,
    `${item.itemClass} · атака`,
    [
      '% увеличение физического урона',
      'добавляет физический / элементарный урон',
      '+N к максимуму здоровья',
    ],
    [
      'скорость атаки',
      'шанс критического удара',
      'бонус критического урона',
      '+N к уровню всех камней умений',
    ],
    ['physicalDamage', 'addedDamage', 'life'],
    ['attackSpeed', 'critChance', 'critMulti', 'skillLevels'],
  );
}

function offhandProfile(item: ParsedItem): AdviceProfile {
  if (item.subtype === 'focus') {
    return equipmentProfile(
      item,
      'Фокус · ЭЩ',
      ['% повышение ЭЩ', '+N к ЭЩ', '+N к духу', '+N к максимуму маны'],
      [
        'скорость сотворения чар',
        'шанс критического удара',
        'бонус критического урона',
        '+N к уровню всех камней умений',
        '+N% к сопротивлению',
      ],
      ['defencePercent', 'defenceFlat', 'spirit', 'mana'],
      ['castSpeed', 'critChance', 'critMulti', 'skillLevels', 'resistance'],
    );
  }
  if (item.subtype === 'quiver') {
    return equipmentProfile(
      item,
      'Колчан · атака',
      ['% увеличение физического урона', 'добавляет физический / элементарный урон', '+N к максимуму здоровья'],
      ['скорость атаки', 'шанс критического удара', 'бонус критического урона', '+N% к сопротивлению'],
      ['physicalDamage', 'addedDamage', 'life'],
      ['attackSpeed', 'critChance', 'critMulti', 'resistance'],
    );
  }
  return armourProfile(item);
}

function jewelleryProfile(item: ParsedItem): AdviceProfile {
  return equipmentProfile(
    item,
    `${item.itemClass} · универсальные`,
    [
      '+N к максимуму здоровья',
      '+N к максимуму маны',
      '+N к духу',
      'добавляет физический / элементарный урон',
    ],
    [
      '+N% к сопротивлению огню / холоду / молнии',
      '+N% к сопротивлению хаосу',
      '+N к силе / ловкости / интеллекту',
      'скорость атаки / сотворения чар',
      'шанс критического удара',
      '+N к уровню всех камней умений',
    ],
    ['life', 'mana', 'spirit', 'addedDamage'],
    [
      'resistance',
      'chaosResistance',
      'attributes',
      'attackSpeed',
      'castSpeed',
      'critChance',
      'critMulti',
      'skillLevels',
    ],
  );
}

function flaskProfile(item: ParsedItem): AdviceProfile {
  return {
    id: 'flask',
    label: `${item.itemClass} · флакон`,
    targetPrefixes: ['эффект флакона', 'восстановление зарядов'],
    targetSuffixes: ['длительность эффекта', 'эффект флакона'],
    targetPrefixFamilies: ['flaskEffect', 'flaskCharge'],
    targetSuffixFamilies: ['flaskDuration', 'flaskEffect'],
    mode: 'flask',
  };
}

function charmProfile(item: ParsedItem): AdviceProfile {
  return {
    id: 'charm',
    label: `${item.itemClass} · оберег`,
    targetPrefixes: ['эффект оберега', 'заряды оберега'],
    targetSuffixes: ['длительность эффекта оберега', 'эффект оберега'],
    targetPrefixFamilies: ['charmEffect', 'flaskCharge'],
    targetSuffixFamilies: ['charmDuration', 'charmEffect'],
    mode: 'charm',
  };
}

function jewelProfile(item: ParsedItem): AdviceProfile {
  return {
    id: 'jewel',
    label: `${item.itemClass} · самоцвет`,
    targetPrefixes: ['+N к максимуму здоровья', '% увеличение урона', 'добавляет урон'],
    targetSuffixes: [
      '+N% к сопротивлению',
      '+N к атрибутам',
      'скорость атаки / сотворения чар',
      'шанс / бонус критического удара',
    ],
    targetPrefixFamilies: ['life', 'damage', 'physicalDamage', 'spellDamage', 'addedDamage'],
    targetSuffixFamilies: [
      'resistance',
      'attributes',
      'attackSpeed',
      'castSpeed',
      'critChance',
      'critMulti',
      'mana',
    ],
    mode: 'jewel',
  };
}

function waystoneProfile(item: ParsedItem): AdviceProfile {
  return {
    id: 'waystone',
    label: `${item.itemClass} · маппинг`,
    targetPrefixes: [
      'количество находимых предметов',
      'редкость найденных предметов',
      'размер групп монстров',
    ],
    targetSuffixes: [
      'эффективность монстров',
      'шанс выпадения путевого камня',
      'редкость найденных предметов',
    ],
    targetPrefixFamilies: ['quantity', 'rarity', 'packSize'],
    targetSuffixFamilies: ['monsterEffectiveness', 'waystoneDrop', 'rarity'],
    mode: item.category === 'tablet' ? 'tablet' : 'waystone',
  };
}

function relicProfile(item: ParsedItem): AdviceProfile {
  return equipmentProfile(
    item,
    `${item.itemClass} · реликвия`,
    ['+N к максимуму здоровья', '% повышение защиты', '+N к духу'],
    ['+N% к сопротивлению', '+N к атрибутам', 'увеличение урона'],
    ['life', 'defencePercent', 'defenceFlat', 'spirit'],
    ['resistance', 'attributes', 'damage'],
  );
}

function profileFor(item: ParsedItem): AdviceProfile | null {
  switch (item.category) {
    case 'armour':
      return armourProfile(item);
    case 'weapon':
      return weaponProfile(item);
    case 'offhand':
      return offhandProfile(item);
    case 'jewellery':
      return jewelleryProfile(item);
    case 'flask':
      return flaskProfile(item);
    case 'charm':
      return charmProfile(item);
    case 'jewel':
      return jewelProfile(item);
    case 'waystone':
    case 'tablet':
      return waystoneProfile(item);
    case 'relic':
      return relicProfile(item);
    case 'trap':
      return weaponProfile(item);
    default:
      return null;
  }
}

function classify(
  kind: 'prefix' | 'suffix',
  text: string,
  profile: AdviceProfile,
): { verdict: AdviceVerdict; reason: string } {
  const family = familyOf(text);
  if (family === 'unknown') {
    return {
      verdict: 'neutral',
      reason: 'мод не распознан — проверь под свой билд',
    };
  }
  const targets =
    kind === 'prefix' ? profile.targetPrefixFamilies : profile.targetSuffixFamilies;
  if (targets.includes(family)) {
    return { verdict: 'good', reason: `целевой мод для ${profile.label}` };
  }
  if (BAD_FAMILIES.has(family)) {
    return { verdict: 'bad', reason: 'слабый мод для этого слота' };
  }
  return { verdict: 'neutral', reason: 'полезно, но не ключевой мод' };
}

function makeSummary(baseLabel: string, itemLevel: number | undefined, action: string): string {
  const level = itemLevel !== undefined ? `, ilvl ${itemLevel}` : '';
  return `${baseLabel}${level}. ${action}`;
}

const TOP_TIERS = 2;

function percent(share: number): string {
  return `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`;
}

/** Шанс целевого мода с одной сферы по весам пула; пусто, если выпасть нечему. */
function orbOdds(
  pool: Pick<ModPool, 'mods'>,
  item: ParsedItem,
  profile: AdviceProfile,
  groups: ModifierGroup[],
  sides: Side[],
): string {
  const rows = pool.mods.filter((mod) => mod.level <= (item.itemLevel ?? 100));
  const present = new Set(groups.flatMap((group) => group.lines.map((line) => statTemplate(line.text))));
  const taken = new Set(rows.filter((mod) => present.has(mod.template)).map((mod) => mod.family));
  const open = rows.filter((mod) => sides.includes(mod.kind) && !taken.has(mod.family));

  const wanted = open.filter((mod) =>
    (mod.kind === 'prefix' ? profile.targetPrefixFamilies : profile.targetSuffixFamilies).includes(
      familyOf(mod.text),
    ),
  );
  const top = wanted.filter(
    (mod) => wanted.filter((other) => other.family === mod.family && other.level > mod.level).length < TOP_TIERS,
  );
  const weight = (mods: typeof rows): number => mods.reduce((sum, mod) => sum + mod.weight, 0);
  const total = weight(open);
  if (total <= 0) return '';
  return `целевой мод ${percent(weight(wanted) / total)}, из верхних ${TOP_TIERS} тиров ${percent(weight(top) / total)}`;
}

export function analyzeCraft(item: ParsedItem, pool?: Pick<ModPool, 'mods'>): CraftAdvice {
  if (item.rarity !== 'normal' && item.rarity !== 'magic' && item.rarity !== 'rare') {
    return unsupported(
      `Советник поддерживает белые, волшебные и редкие предметы (сейчас: ${item.rarity}).`,
    );
  }

  const profile = profileFor(item);
  if (!profile) {
    return unsupported(
      `Для типа «${item.itemClass}» пока нет профиля рекомендаций.`,
    );
  }

  const groups = item.modifiers.filter(
    (modifier) =>
      modifier.source === 'explicit' &&
      (modifier.kind === 'prefix' || modifier.kind === 'suffix'),
  );

  const mods: AdviceMod[] = groups.map((group) => {
    const kind = group.kind === 'prefix' ? 'prefix' : 'suffix';
    const text = groupText(group);
    const result = classify(kind, text, profile);
    return {
      kind,
      text,
      ...(group.tier !== undefined ? { tier: group.tier } : {}),
      verdict: result.verdict,
      reason: result.reason,
    };
  });

  const prefixes = groups.filter((group) => group.kind === 'prefix').length;
  const suffixes = groups.filter((group) => group.kind === 'suffix').length;
  const maxPrefixes = item.rarity === 'magic' ? 1 : 3;
  const maxSuffixes = item.rarity === 'magic' ? 1 : 3;
  const openPrefixes = Math.max(0, maxPrefixes - prefixes);
  const openSuffixes = Math.max(0, maxSuffixes - suffixes);

  const counts: AdviceCounts = {
    prefixes,
    suffixes,
    openPrefixes,
    openSuffixes,
    good: mods.filter((mod) => mod.verdict === 'good').length,
    neutral: mods.filter((mod) => mod.verdict === 'neutral').length,
    bad: mods.filter((mod) => mod.verdict === 'bad').length,
  };

  const warnings: string[] = [];
  if (groups.length > 0 && groups.every((group) => group.tier === undefined)) {
    warnings.push('В тексте нет тиров — для точной оценки нужен advanced-copy (Ctrl+Alt+C).');
  }
  if (prefixes > maxPrefixes || suffixes > maxSuffixes) {
    warnings.push('Модов больше, чем ожидается для этой редкости — проверь текст.');
  }

  const baseLabel = item.name ?? item.baseType ?? item.itemClass;
  const levelText = item.itemLevel !== undefined ? `, ilvl ${item.itemLevel}` : '';

  let summary = '';
  let steps: string[] = [];

  const phrase = (sides: Side[]): string => (pool ? orbOdds(pool, item, profile, groups, sides) : '');
  const odds = (sides: Side[]): string => {
    const text = phrase(sides);
    return text ? ` Шанс: ${text}.` : '';
  };
  const sideOdds = (label: string, side: Side): string => {
    const text = phrase([side]);
    return text ? ` ${label}: ${text}.` : '';
  };
  const openSides: Side[] = [
    ...(openPrefixes > 0 ? (['prefix'] as const) : []),
    ...(openSuffixes > 0 ? (['suffix'] as const) : []),
  ];

  if (profile.mode === 'waystone' || profile.mode === 'tablet') {
    summary = `${profile.label}${levelText}. Оценка по модам для маппинга.`;
    steps = [
      'Смотри на количество и редкость находимых предметов, размер групп монстров.',
      'Эффективность монстров повышает опасность — учитывай свой билд.',
      'Хороший набор не рероллить; крафт путевых камней валютой — отдельная тема.',
    ];
  } else if (item.rarity === 'normal') {
    summary = makeSummary(
      `Белый ${baseLabel}`,
      item.itemLevel,
      'Цель — получить 2 целевых мода и решить, делать ли редким.',
    );
    steps = [
      `Сфера превращения (Orb of Transmutation) — сделать волшебным, получить 1 мод.${odds(['prefix', 'suffix'])}`,
      `Сфера усиления (Orb of Augmentation) — добавить 2-й мод на свободную сторону.${sideOdds('После префикса', 'suffix')}${sideOdds('После суффикса', 'prefix')}`,
      `Если оба мода из целевого списка → Сфера царей (Regal Orb).${odds(['prefix', 'suffix'])} Если один или мусор → Сфера алхимии (Alchemy) / новый base.`,
    ];
  } else if (item.rarity === 'magic') {
    if (counts.prefixes + counts.suffixes === 0) {
      summary = makeSummary(`Волшебный ${baseLabel}`, item.itemLevel, 'Явных модов не видно.');
      steps = [
        'Проверь копирование: нужен advanced-copy (Alt+F / Ctrl+Alt+C).',
        'Если модов действительно нет — начни с Сферы превращения → Сферы усиления.',
      ];
    } else if (counts.prefixes + counts.suffixes === 1) {
      if (counts.good > 0) {
        summary = makeSummary(`Один хороший мод. ${baseLabel}`, item.itemLevel, '');
        steps = [
          `Сфера усиления (Orb of Augmentation) — добавить второй мод.${odds(openSides)}`,
          'Если второй мод тоже целевой → Сфера царей (Regal Orb).',
          'Если второй мод мусорный → Сфера алхимии (Alchemy) / новый base.',
        ];
      } else {
        summary = makeSummary(`Один мод, но он не из целевых. ${baseLabel}`, item.itemLevel, '');
        steps = [
          'Не тратить Сферу усиления на эту базу.',
          'Сфера алхимии (Alchemy Orb) или новый base — иначе Regal закрепит слабый мод.',
        ];
      }
    } else if (counts.good >= 2) {
      summary = makeSummary(`Оба мода целевые. ${baseLabel}`, item.itemLevel, '');
      steps = [
        `Сфера царей (Regal Orb) — сделать предмет редким, сохранив оба мода.${odds(['prefix', 'suffix'])}`,
        'Дальше смотри совет для редкого предмета.',
      ];
    } else if (counts.good === 1) {
      summary = makeSummary(`Один целевой мод и один нецелевой. ${baseLabel}`, item.itemLevel, '');
      steps = [
        'Сфера царей (Regal) закрепит мусор — обычно не лучший вариант.',
        'Сфера алхимии (Alchemy Orb) или новый base.',
      ];
    } else {
      summary = makeSummary(`Целевых модов нет. ${baseLabel}`, item.itemLevel, '');
      steps = [
        'Не тратить Сферу царей на эту пару.',
        'Сфера алхимии (Alchemy Orb) для полного реролла или новый base.',
      ];
    }
  } else {
    const openSlots = openPrefixes + openSuffixes;
    if (counts.good === 0) {
      summary = makeSummary(`Редкий ${baseLabel}`, item.itemLevel, 'Целевых модов нет.');
      steps = [
        'Не тратить валюту на докрафт.',
        'Сфера хаоса / алхимии рискованны — лучше новый base.',
      ];
    } else if (counts.good >= 2 && openSlots > 0) {
      summary = makeSummary(
        `${counts.good} целевых мода, открыто слотов: ${openSlots}. ${baseLabel}`,
        item.itemLevel,
        '',
      );
      steps = [
        `Сфера возвышения (Exalted Orb) в открытые слоты — попытка усилить предмет.${odds(openSides)}`,
        'Если попадёт мусор — остановиться, не рероллить хорошие моды.',
      ];
    } else if (counts.good >= 2) {
      summary = makeSummary(`Сильный набор: ${counts.good} целевых мода. ${baseLabel}`, item.itemLevel, '');
      steps = [
        'Не рероллить: моды уже сильные.',
        'Дальше — только если уверен в конкретном апгрейде; без цен оценка не считается.',
      ];
    } else if (counts.good === 1 && counts.bad >= 2) {
      summary = makeSummary(`Один целевой мод и много мусора. ${baseLabel}`, item.itemLevel, '');
      steps = [
        'Сфера хаоса (Chaos Orb) рискованно: может убрать хороший мод.',
        'Для новичка — новый base выгоднее по нервам и результату.',
      ];
    } else if (counts.good === 1) {
      summary = makeSummary(`Один целевой мод. ${baseLabel}`, item.itemLevel, '');
      steps = [
        openSlots > 0
          ? `Можно попробовать Сферу возвышения (Exalted Orb) в открытый слот, но рискованно.${odds(openSides)}`
          : 'Свободных слотов нет — докрафт невозможен без Сферы отмены (Annul) / Сферы хаоса.',
        'Если не готов рисковать — оставь как есть / новый base.',
      ];
    } else {
      summary = makeSummary(`Целевых модов мало. ${baseLabel}`, item.itemLevel, '');
      steps = [
        'Не тратить дорогую валюту.',
        'Сфера алхимии / новый base; Сфера хаоса без понимания рисков не советую.',
      ];
    }
  }

  steps.push(
    pool
      ? 'Шансы — по весам модов для этого уровня предмета, без оменов. Для своего образца нажми Alt+G.'
      : 'Оценка без цен: ориентир — целевые моды, тиры и открытые слоты.',
  );

  return {
    supported: true,
    profile: `${profile.label} (пробный режим)`,
    summary,
    steps,
    targetPrefixes: profile.targetPrefixes,
    targetSuffixes: profile.targetSuffixes,
    mods,
    counts,
    warnings,
  };
}
