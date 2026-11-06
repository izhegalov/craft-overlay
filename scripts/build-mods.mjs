// Собирает data/reference/mods-data.json с poe2db (CC BY-NC-SA 3.0).
// Запуск: node scripts/build-mods.mjs [файл]
// Вес 1 на poe2db значит «неизвестен»: см. docs/TARGET-ITEMS.md.
import { readFileSync, writeFileSync } from 'node:fs';

const TARGET = new URL('../data/reference/mods-data.json', import.meta.url);
const SECTIONS = [
  'normal',
  'corrupted',
  'desecrated',
  'essence',
  'perfect_essence',
  'liquid',
  'soul',
  'chronomancy',
  'destruction',
  'marksman',
  'decay',
  'berserking',
];
const DELAY_MS = 400;

/** Объект из вызова new ModsView({...}) в коде страницы. */
function modsView(html) {
  const start = html.indexOf('new ModsView(');
  if (start < 0) return null;
  const from = start + 'new ModsView('.length;
  let depth = 0;
  let inString = false;
  for (let index = from; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(from, index + 1));
    }
  }
  return null;
}

function plain(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z#0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Имя аффикса склоняется по роду предмета: берём первую форму. */
function affixName(raw) {
  return plain(String(raw).match(/<if:MS>\{([^}]*)\}/)?.[1] ?? raw);
}

function toRow(mod) {
  const [first = '', ...rest] = String(mod.str ?? '').split(/<br\s*\/?>/);
  const generation = String(mod.ModGenerationTypeID);
  const tags = (mod.mod_no ?? []).flatMap((badge) => badge.match(/data-tag="([^"]+)"/)?.[1] ?? []);
  const extra = rest.map(plain).filter(Boolean);
  return {
    n: affixName(mod.Name ?? mod.Code ?? ''),
    lvl: Number(mod.Level),
    g: generation === '1' ? 'prefix' : generation === '2' ? 'suffix' : 'other',
    w: Number(mod.DropChance) || 0,
    d: plain(first),
    f: (mod.ModFamilyList ?? []).join('/'),
    ...(extra.length > 0 ? { x: extra } : {}),
    ...(tags.length > 0 ? { t: tags } : {}),
  };
}

function toSection(key, view) {
  const groups = new Map();
  for (const mod of view[key] ?? []) {
    const row = toRow(mod);
    const group = groups.get(row.f) ?? { key: row.f, name: row.n, type: row.g, rows: [] };
    group.rows.push(row);
    groups.set(row.f, group);
  }
  const config = view.config?.[key] ?? {};
  return {
    key,
    title: plain(config.title ?? key),
    icon: config.icon?.match(/src="([^"]+)"/)?.[1] ?? '',
    groups: [...groups.values()],
  };
}

async function fetchClass(key) {
  const response = await fetch(`https://poe2db.tw/ru/${key}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  });
  if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
  const view = modsView(await response.text());
  if (!view) throw new Error(`${key}: нет данных модов на странице`);
  return view;
}

// Список классов и подписи живут в самом файле: на poe2db нет их общего списка.
const current = JSON.parse(readFileSync(TARGET, 'utf8'));
const classes = [];
for (const { key, title } of current.classes) {
  const view = await fetchClass(key);
  const sections = SECTIONS.map((section) => toSection(section, view)).filter(
    (section) => section.groups.length > 0,
  );
  classes.push({ key, title, sections });
  console.log(key, sections.map((section) => section.key).join(' '));
  await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
}

writeFileSync(process.argv[2] ?? TARGET, JSON.stringify({ classes }));
