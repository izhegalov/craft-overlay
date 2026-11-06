import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseItemText } from '../src/core/parser';
import type { ParsedItem } from '../src/core/types';
import { buildPool, poolKey, sameBase, statTemplate, type ModPool, type ModsData } from '../src/core/target/modpool';
import { analyzeCraft } from '../src/core/craft/advisor';
import { analyzeTarget, readTargetMods, suggestBases } from '../src/core/target/planner';
import { parseNinjaOverview } from '../src/core/target/prices';

const data = JSON.parse(
  readFileSync(new URL('../data/reference/mods-data.json', import.meta.url), 'utf8'),
) as ModsData;
const enRu = JSON.parse(
  readFileSync(new URL('../data/reference/en-ru-map.json', import.meta.url), 'utf8'),
) as Record<string, string>;
const ruToEn = Object.fromEntries(Object.entries(enRu).map(([en, ru]) => [ru, en]));

function parse(text: string): ParsedItem {
  const result = parseItemText(text, 'ru');
  if (!result.item) throw new Error('item not parsed');
  return result.item;
}

function ring(rarity: string, ilvl: number, mods: string, name = 'Имя\nРубиновое кольцо'): ParsedItem {
  const title = rarity === 'Редкий' ? name : 'Рубиновое кольцо';
  return parse(`Класс предмета: Кольца
Редкость: ${rarity}
${title}
--------
Уровень предмета: ${ilvl}
--------
${mods}`);
}

const LIFE = '{ Префикс "Вепря" (Уровень: 2) — Здоровье }\n+100(90-110) к максимуму здоровья';
const FIRE = '{ Суффикс "Огня" (Уровень: 2) — Огонь }\n+40(36-45)% к сопротивлению огню';
const COLD = '{ Суффикс "Льда" (Уровень: 2) — Холод }\n+40(36-45)% к сопротивлению холоду';

const pool = buildPool(data, 'Rings', ruToEn) as ModPool;
const prices = { exalted: 1, annul: 100, chaos: 20, regal: 1, aug: 1, transmute: 1, alch: 1 };
const options = { pool, tolerance: 0.2, prices, trials: 150, allPaths: true };

describe('modpool', () => {
  it('шаблон строки игры совпадает с шаблоном базы модов', () => {
    expect(statTemplate('+45 к максимуму здоровья')).toBe(statTemplate('+(42—49) к максимуму здоровья'));
    expect(statTemplate('Регенерация 14.3 здоровья в секунду')).toBe(
      statTemplate('Регенерация (13.1—18) здоровья в секунду'),
    );
  });

  it('класс доспеха выбирается по защите предмета', () => {
    const item = parse(`Класс предмета: Шлемы
Редкость: Редкий
Имя
Тиара
--------
Энергетический щит: 100
Броня: 50
--------
Уровень предмета: 80`);
    expect(poolKey(item)).toBe('Helmets_str_int');
  });

  it('совершенные сущности и сплавы заменяют случайный мод', () => {
    expect(pool.essences.some((essence) => essence.perfect)).toBe(true);
    const alloys = buildPool(data, 'Body_Armours_int', ruToEn)?.essences.filter((essence) => /сплав/i.test(essence.name));
    expect(alloys?.length).toBeGreaterThan(0);
    expect(alloys?.every((alloy) => alloy.perfect)).toBe(true);
  });
});

describe('analyzeTarget', () => {
  const target = ring('Редкий', 80, `${LIFE}\n${FIRE}\n${COLD}`);

  it('целевые моды читаются и из advanced, и из текста без заголовков', () => {
    expect(readTargetMods(target, pool, 0.2).map((mod) => mod.kind)).toEqual(['prefix', 'suffix', 'suffix']);
    const basic = ring('Редкий', 80, '+100 к максимуму здоровья');
    expect(readTargetMods(basic, pool, 0.2)).toHaveLength(1);
  });

  it('другая база отклоняется', () => {
    const other = parse('Класс предмета: Кольца\nРедкость: Редкий\nИмя\nЗолотое кольцо\n--------\nУровень предмета: 80');
    const report = analyzeTarget(other, target, options);
    expect(report.verdict).toBe('unreachable');
    expect(report.reasons[0]).toContain('Другая база');
  });

  it('предмет с модами в допуске уже готов', () => {
    const item = ring('Редкий', 80, LIFE.replace('+100(', '+85(') + `\n${FIRE}\n${COLD}`);
    const report = analyzeTarget(item, target, options);
    expect(report.verdict).toBe('ready');
    expect(report.strategies).toHaveLength(0);
  });

  it('значение ниже допуска не засчитывается', () => {
    const item = ring('Редкий', 80, LIFE.replace('+100(', '+70(') + `\n${FIRE}\n${COLD}`);
    const report = analyzeTarget(item, target, options);
    expect(report.mods[0]?.status).toBe('need');
  });

  it('низкий уровень предмета называет нужный, но не отменяет расчёт остального', () => {
    const report = analyzeTarget(ring('Редкий', 1, FIRE), target, options);
    expect(report.verdict).toBe('partial');
    expect(report.mods.find((mod) => mod.status === 'impossible')?.note).toContain('нужен уровень предмета');
  });

  it('мод вне данных не делает образец недостижимым и держит слот', () => {
    const special = `${LIFE}\n${FIRE}\n{ Суффикс "Тайны" }\n+5 к чему-то неведомому`;
    const report = analyzeTarget(ring('Редкий', 80, LIFE), ring('Редкий', 80, special), options);
    expect(report.verdict).toBe('partial');
    expect(report.mods[2]?.status).toBe('special');
    expect(report.strategies.some((entry) => entry.probability > 0)).toBe(true);
  });

  it('очернённый мод считается через очернение', () => {
    const desecrated = pool.desecrated.find((mod) => mod.kind === 'suffix' && mod.level <= 80);
    expect(desecrated).toBeDefined();
    const text = (desecrated?.text ?? '').replace(/\((\d+)[^)]*\)/g, '$1');
    const goal = ring('Редкий', 80, `${LIFE}\n{ Очернённое Суффикс "${desecrated?.name}" }\n${text}`);
    const report = analyzeTarget(ring('Редкий', 80, LIFE), goal, options);
    expect(report.mods[1]?.note).toContain('очернение');
    const best = report.strategies.find((entry) => entry.probability > 0);
    expect(best?.uses.map((use) => use.id)).toContain('preserved-collarbone');
  });

  it('значение с качеством сравнивается без качества', () => {
    const boosted = '{ Суффикс "Огня" (Уровень: 2) — Огонь — 40% увеличение }\n+56(50-63)% к сопротивлению огню';
    const goal = ring('Редкий', 80, boosted);
    const report = analyzeTarget(ring('Редкий', 80, FIRE), goal, options);
    expect(report.mods[0]?.status).toBe('have');
  });

  it('мод, которого нет в классе, берёт вес из другого класса', () => {
    const fixture = readFileSync(new URL('../fixtures/ru/rare-ring-advanced.txt', import.meta.url), 'utf8');
    const goal = parse(fixture);
    const item = parse(fixture.replace(/\{ Префикс "Оккультное"[^\n]*\n[^\n]*\n/, ''));
    const report = analyzeTarget(item, goal, { ...options, pool: buildPool(data, 'Rings', ruToEn) as ModPool });
    expect(report.mods[0]?.status).toBe('need');
    expect(report.mods[0]?.note).toContain('другого класса');
    const copies = pool.borrowed.filter((mod) => mod.text === '(3—7)% увеличение урона от чар');
    expect(copies.length).toBeLessThanOrEqual(1);
  });

  it('значение выше всех тиров берётся как лучший тир', () => {
    const goal = ring('Редкий', 80, '{ Префикс "Вепря" (Уровень: 1) }\n+900 к максимуму здоровья');
    const report = analyzeTarget(ring('Редкий', 80, FIRE), goal, options);
    expect(report.mods[0]?.note).toContain('лучший тир');
    expect(report.verdict).toBe('reachable');
  });

  it('Divine вытягивает низкий ролл в нужном тире', () => {
    const top = pool.mods.filter((mod) => mod.template === statTemplate('+10 к максимуму здоровья'))
      .sort((a, b) => b.level - a.level)[0];
    const [low, high] = top?.ranges[0] ?? [0, 0];
    const goal = ring('Редкий', 80, `{ Префикс "${top?.name}" (Уровень: 1) }\n+${high} к максимуму здоровья`);
    const item = ring('Редкий', 80, `{ Префикс "${top?.name}" (Уровень: 1) }\n+${low} к максимуму здоровья`);
    const report = analyzeTarget(item, goal, { ...options, tolerance: 0.01 });
    const divine = report.strategies.find((entry) => entry.id === 'exalt-divine');
    expect(divine?.probability).toBeGreaterThan(0.5);
    expect(divine?.uses.map((use) => use.id)).toEqual(['divine']);
  });

  it('осквернённый предмет менять нельзя', () => {
    const report = analyzeTarget(ring('Редкий', 80, `${LIFE}\n--------\nОсквернено`), target, options);
    expect(report.reasons[0]).toContain('нельзя');
  });

  it('омен стороны тратит меньше возвышений и считает свой расход', () => {
    const item = ring('Редкий', 80, `${FIRE}\n${COLD}`);
    const report = analyzeTarget(item, target, options);
    const plain = report.strategies.find((entry) => entry.id === 'exalt');
    const omen = report.strategies.find((entry) => entry.id === 'exalt-omen');
    expect(report.verdict).toBe('reachable');
    const exalts = (entry: typeof plain): number =>
      entry?.uses.find((use) => use.id === 'exalted')?.average ?? 0;
    expect(exalts(omen)).toBeLessThan(exalts(plain));
    expect(omen?.uses.map((use) => use.id)).toContain('omen-of-sinistral-exaltation');
    expect(omen?.incompleteCost).toBe(true);
    expect(plain?.incompleteCost).toBe(false);
    expect(plain?.costPerSuccess).toBeCloseTo((plain?.costPerAttempt ?? 0) / (plain?.probability ?? 1));
  });

  it('без открытого слота помогает только цикл с удалением', () => {
    const junk = '{ Префикс "Мусор" (Уровень: 9) — Атака }\n+10 к меткости';
    const item = ring('Редкий', 80, `${junk}\n{ Префикс "М2" (Уровень: 9) }\n+5 к духу\n{ Префикс "М3" (Уровень: 9) }\n+5 к максимуму маны\n${FIRE}\n${COLD}`);
    const report = analyzeTarget(item, target, options);
    expect(report.strategies.find((entry) => entry.id === 'exalt')?.probability ?? 0).toBe(0);
    expect(report.strategies.find((entry) => entry.id === 'annul-loop')?.probability).toBeGreaterThan(0);
  });

  it('слабый мод того же семейства мешает, пока его не уберут', () => {
    const weak = '{ Префикс "Слабый" (Уровень: 9) — Здоровье }\n+20(15-25) к максимуму здоровья';
    const report = analyzeTarget(ring('Редкий', 80, `${weak}\n${FIRE}\n${COLD}`), target, options);
    expect(report.mods[0]?.status).toBe('need');
    expect(report.strategies.find((entry) => entry.id === 'exalt')?.probability ?? 0).toBe(0);
    expect(report.strategies.find((entry) => entry.id === 'annul-loop')?.probability).toBeGreaterThan(0);
  });

  it('гибрид опознаётся по имени аффикса и не путается с обычным модом', () => {
    const helmetPool = buildPool(data, 'Helmets_int', ruToEn) as ModPool;
    const helmet = parse(readFileSync(new URL('../fixtures/ru/rare-helmet-advanced.txt', import.meta.url), 'utf8'));
    const mods = readTargetMods(helmet, helmetPool, 0.2);
    expect(mods[0]?.family).toBe('BaseLocalDefencesAndLife');
    expect(mods[1]?.family).toBe('DefencesPercent');
    expect(mods[0]?.template).toBe(mods[1]?.template);
  });

  it('нужный мод показывает шанс одной сферы', () => {
    const report = analyzeTarget(ring('Редкий', 80, FIRE), target, options);
    expect(report.mods[0]?.note).toMatch(/с оменом стороны \d+\.\d+%/);
  });

  it('показывает не больше трёх путей: дешёвый, вероятный и запасной', () => {
    const report = analyzeTarget(ring('Редкий', 80, FIRE), target, { pool, tolerance: 0.2, prices, trials: 150 });
    expect(report.strategies.length).toBeGreaterThan(1);
    expect(report.strategies.length).toBeLessThanOrEqual(3);
    expect(report.strategies[0]?.tag).toBe('Дешевле всего');
    expect(report.strategies.every((entry) => entry.steps.length > 1)).toBe(true);
    expect(new Set(report.strategies.map((entry) => entry.id)).size).toBe(report.strategies.length);
  });

  it('большая сфера не даёт моды ниже своего уровня', () => {
    const report = analyzeTarget(ring('Редкий', 80, FIRE), target, options);
    const perfect = report.strategies.find((entry) => entry.id === 'exalt-perfect');
    expect(perfect?.uses.map((use) => use.id)).toContain('perfect-exalted-orb');
    expect(perfect?.uses.map((use) => use.id)).not.toContain('exalted');
  });

  it('раскол закрепляет мод, хаос с оменом тратит свой омен', () => {
    const report = analyzeTarget(ring('Редкий', 80, FIRE), target, options);
    const fracture = report.strategies.find((entry) => entry.id === 'fracture-annul');
    expect(fracture?.uses.map((use) => use.id)).toContain('fracturing-orb');
    const whittling = report.strategies.find((entry) => entry.id === 'chaos-whittling');
    expect(whittling?.uses.map((use) => use.id)).toContain('omen-of-whittling');
  });

  it('отмена без омена задевает другую сторону, омен её бережёт', () => {
    const junk = ['Мана', 'Дух', 'Меткость'].map((name, index) => {
      const line = ['+5 к максимуму маны', '+5 к духу', '+10 к меткости'][index];
      return `{ Префикс "${name}" (Уровень: 9) }\n${line}`;
    });
    const item = ring('Редкий', 80, [...junk, FIRE, COLD].join('\n'));
    const report = analyzeTarget(item, target, { ...options, trials: 300 });
    const count = (id: string, use: string): number =>
      report.strategies.find((entry) => entry.id === id)?.uses.find((entry) => entry.id === use)?.average ?? 0;
    // Снятый хороший суффикс приходится докрафчивать: возвышений на успех выходит больше.
    const plain = report.strategies.find((entry) => entry.id === 'annul-plain');
    const omen = report.strategies.find((entry) => entry.id === 'annul-loop');
    expect(plain?.uses.some((use) => use.id.startsWith('omen'))).toBe(false);
    expect(omen?.uses.some((use) => use.id === 'omen-of-sinistral-annulment')).toBe(true);
    expect(count('annul-plain', 'annul')).toBeGreaterThan(0);
    expect(plain?.probability ?? 1).toBeLessThan(omen?.probability ?? 0);
  });

  it('цена заготовки входит в стоимость через риск потери', () => {
    const item = ring('Редкий', 80, `${FIRE}\n${COLD}`);
    const free = analyzeTarget(item, target, options).strategies.find((entry) => entry.id === 'exalt');
    const paid = analyzeTarget(item, target, { ...options, basePrice: 1000 }).strategies.find((entry) => entry.id === 'exalt');
    const chance = free?.probability ?? 0;
    expect(free?.basePriceMissing).toBe(true);
    expect(paid?.basePriceMissing).toBe(false);
    expect(paid?.basesPerSuccess).toBeCloseTo(1 / chance);
    expect((paid?.costPerSuccess ?? 0) - (free?.costPerSuccess ?? 0)).toBeCloseTo((1000 * (1 - chance)) / chance);
  });

  it('гарантированный путь не платит за заготовку', () => {
    const item = ring('Редкий', 80, `${LIFE}\n${FIRE}\n${COLD}`);
    const report = analyzeTarget(item, target, { ...options, basePrice: 1000 });
    expect(report.verdict).toBe('ready');
  });

  it('результат воспроизводим', () => {
    const item = ring('Редкий', 80, FIRE);
    expect(analyzeTarget(item, target, options)).toEqual(analyzeTarget(item, target, options));
  });
});

describe('вставки', () => {
  const socketables = {
    items: [
      { id: 'desert-rune', kind: 'rune' as const, name: 'Руна пустыни', effects: [{ slot: 'Доспехи', text: '+14% к сопротивлению огню' }] },
      { id: 'idol-a', kind: 'idol' as const, name: 'Идол', effects: [{ slot: 'Перчатки', text: '8% повышение скорости атаки' }] },
    ],
  };
  function armour(rarity: string, mods: string, sockets: string, runes = ''): ParsedItem {
    return parse(`Класс предмета: Шлемы
Редкость: ${rarity}
Имя
Тиара
--------
Энергетический щит: 100
--------
Гнезда: ${sockets}
--------
Уровень предмета: 80
--------
${mods}${runes ? `\n--------\n${runes}` : ''}`);
  }
  const helmetPool = buildPool(data, 'Helmets_int', ruToEn) as ModPool;
  const helmetOptions = {
    pool: helmetPool,
    tolerance: 0.2,
    prices: { ...prices, 'desert-rune': 2, artificers: 3 },
    trials: 150,
    socketables,
  };
  const FIRE_LINE = '+28% к сопротивлению огню (rune)';

  it('руна из образца считается как две одинаковых и добавляет цену и гнездо', () => {
    const goal = armour('Редкий', FIRE, 'S S', FIRE_LINE);
    const report = analyzeTarget(armour('Редкий', FIRE, 'S'), goal, helmetOptions);
    expect(report.verdict).toBe('reachable');
    expect(report.strategies[0]?.id).toBe('finish');
    expect(report.strategies[0]?.costPerSuccess).toBeCloseTo(2 * 2 + 3);
    expect(report.mods[1]?.note).toContain('Руна пустыни × 2');
  });

  it('вставка на месте не требует расходов', () => {
    const goal = armour('Редкий', FIRE, 'S S', FIRE_LINE);
    const report = analyzeTarget(armour('Редкий', FIRE, 'S S', FIRE_LINE), goal, helmetOptions);
    expect(report.verdict).toBe('ready');
  });

  it('неизвестная вставка не мешает расчёту', () => {
    const goal = armour('Редкий', FIRE, 'S', 'Касание Ворона (rune)');
    const report = analyzeTarget(armour('Редкий', FIRE, 'S'), goal, helmetOptions);
    expect(report.mods[1]?.status).toBe('special');
    expect(report.verdict).toBe('partial');
  });
});

describe('parseNinjaOverview', () => {
  it('переводит цены в Exalted', () => {
    const prices = parseNinjaOverview({
      core: { primary: 'divine', rates: { exalted: 500, chaos: 8 } },
      lines: [{ id: 'chaos', primaryValue: 0.1 }, { id: 'divine', primaryValue: 1 }],
    });
    expect(prices.chaos).toBeCloseTo(50);
    expect(prices.divine).toBe(500);
    expect(prices.exalted).toBe(1);
  });

  it('отвергает незнакомый формат', () => {
    expect(() => parseNinjaOverview({})).toThrow();
  });
});

describe('база предмета', () => {
  it('приставка качества у белого предмета не мешает сравнению', () => {
    const text = readFileSync(new URL('../fixtures/ru/normal-body-armour-advanced.txt', import.meta.url), 'utf8');
    expect(sameBase(parse(text), 'Дублёный плащ')).toBe(true);
    expect(sameBase(parse(text), 'Другой плащ')).toBe(false);
  });
});

describe('шансы шагов', () => {
  const sample = ring('Редкий', 80, [LIFE, FIRE, COLD].join('\n\n'));
  const white = ring('Обычный', 80, '');

  it('шанс Сферы превращения равен доле весов нужных модов', () => {
    const report = analyzeTarget(white, sample, { ...options, tolerance: 0 });
    const step = report.strategies
      .flatMap((strategy) => strategy.steps)
      .find((entry) => entry.title === 'Сфера превращения');
    const rows = readTargetMods(sample, pool, 0);
    const open = pool.mods.filter((mod) => mod.level <= 80);
    const total = open.reduce((sum, mod) => sum + mod.weight, 0);
    const wanted = open.reduce((sum, mod) => {
      const row = rows.find((entry) => entry.template === mod.template && entry.family === mod.family);
      const [low = 0, high = 0] = mod.ranges[0] ?? [];
      const minimum = row?.minimums[0] ?? 0;
      if (!row || minimum > high) return sum;
      return sum + mod.weight * (minimum <= low ? 1 : (high - minimum) / (high - low));
    }, 0);
    expect(step?.chance).toBeCloseTo(wanted / total, 6);
    expect(step?.chanceOf).toBe('нужный мод');
  });

  it('совет Alt+F считает шанс по весам пула', () => {
    const steps = analyzeCraft(white, pool).steps;
    expect(steps[0]).toMatch(/целевой мод \d+\.\d+%, из верхних 2 тиров \d/);
    expect(steps[1]).toContain('После префикса');
    expect(analyzeCraft(white).steps.join(' ')).not.toContain('целевой мод');
  });
});

describe('какую базу купить', () => {
  const { allPaths: _all, ...rest } = options;
  const allPriced = new Proxy<Record<string, number>>({}, { get: () => 5 });
  const quick = { ...rest, prices: allPriced, trials: 30, basePrice: 1 };
  const STORM = ['{ Суффикс "Бури" (Уровень: 2) — Молния }', '+40(36-45)% к сопротивлению молнии'].join(String.fromCharCode(10));
  const mods = (...list: string[]): string => list.join(String.fromCharCode(10, 10));

  it('покупка с готовым модом окупается и имеет предел цены', () => {
    const advice = suggestBases(ring('Редкий', 80, mods(LIFE, FIRE, COLD)), quick);
    expect(advice.white?.probability).toBeGreaterThan(0);
    expect(advice.itemLevel).toBeGreaterThan(1);
    expect(advice.options.length).toBeGreaterThan(0);
    for (const option of advice.options) {
      expect(option.maxPrice).toBeGreaterThan(0);
      expect(option.mods.length).toBeLessThan(3);
    }
  }, 30000);

  it('два суффикса не помещаются на волшебный предмет', () => {
    const advice = suggestBases(ring('Редкий', 80, mods(LIFE, FIRE, COLD, STORM)), quick);
    expect(advice.options.find((option) => option.mods.length === 3)?.rarity).toBe('rare');
    expect(advice.options.find((option) => option.mods.length === 2)?.rarity).toBe('magic');
  }, 30000);
});

describe('неизвестные веса', () => {
  const castSpeed = pool.mods.filter((mod) => mod.family === 'IncreasedCastSpeed');

  it('вес 1 оценивается по такому же моду другого класса', () => {
    expect(castSpeed.length).toBeGreaterThan(0);
    for (const mod of castSpeed) {
      expect(mod.estimated).toBe(true);
      expect(mod.weight).toBeGreaterThan(1);
    }
    expect(pool.mods.find((mod) => mod.family === 'Strength')?.estimated).toBeUndefined();
  });

  it('неизвестный вес не используется как запасной источник', () => {
    expect(pool.borrowed.every((mod) => mod.weight > 1)).toBe(true);
  });

  it('класс без единого известного веса остаётся равномерным', () => {
    const diamond = buildPool(data, 'Diamond', ruToEn) as ModPool;
    expect(diamond.mods.every((mod) => mod.weight === 1 && !mod.estimated)).toBe(true);
  });

  it('доспех с тремя защитами берёт веса у родственных классов', () => {
    const armour = buildPool(data, 'Body_Armours_str_dex_int', ruToEn) as ModPool;
    const estimated = armour.mods.filter((mod) => mod.estimated).length;
    expect(estimated).toBeGreaterThan(armour.mods.length * 0.9);
  });

  it('мод с оценённым весом помечен в отчёте', () => {
    const cast = '{ Суффикс "таланта" (Уровень: 3) }\n20(19-21)% повышение скорости сотворения чар';
    const sample = ring('Редкий', 80, cast);
    const report = analyzeTarget(ring('Обычный', 80, ''), sample, options);
    expect(report.mods[0]?.note).toContain('вес оценён');
  });
});

describe('гибриды', () => {
  const armourPool = buildPool(data, 'Body_Armours_dex', ruToEn) as ModPool;
  const plate = (rarity: string, evasion: number, life: number): ParsedItem =>
    parse(`Класс предмета: Нательные доспехи
Редкость: ${rarity}
Имя
Дублёный плащ
--------
Уровень предмета: 80
--------
{ Префикс "Блошиный" (Уровень: 8) }
${evasion}(6-13)% увеличение уклонения
+${life}(7-10) к максимуму здоровья`);

  it('в данных есть обе строки гибрида и их диапазоны', () => {
    const row = armourPool.mods.find((mod) => mod.name === 'Блошиный');
    expect(row?.extraTemplates).toEqual([statTemplate('+(7—10) к максимуму здоровья')]);
    expect(row?.ranges).toEqual([[6, 13], [7, 10]]);
  });

  it('вторая строка гибрида проходит проверку значения', () => {
    const options = { pool: armourPool, tolerance: 0, prices: {}, trials: 10 };
    expect(analyzeTarget(plate('Редкий', 12, 10), plate('Редкий', 12, 10), options).mods[0]?.status).toBe('have');
    expect(analyzeTarget(plate('Редкий', 12, 7), plate('Редкий', 12, 10), options).mods[0]?.status).toBe('need');
  });
});
