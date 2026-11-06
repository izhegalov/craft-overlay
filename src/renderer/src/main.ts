import { parseItemText } from '../../core/parser';
import { analyzeCraft } from '../../core/craft/advisor';
import { poolFor } from '../../core/target/pools';
import { initSettings } from './settings';
import type { CraftAdvice } from '../../core/craft/advisor';
import type { ModifierGroup, ModValue, ParsedItem, StatLine } from '../../core/types';

function queryRequired<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Не найден элемент: ${selector}`);
  return element;
}

const textarea = queryRequired<HTMLTextAreaElement>('#item-text');
const result = queryRequired<HTMLElement>('#result');
const status = queryRequired<HTMLElement>('#status');
const pasteButton = queryRequired<HTMLButtonElement>('#paste');
const clearButton = queryRequired<HTMLButtonElement>('#clear');

const RARITY_LABEL: Record<string, string> = {
  normal: 'Обычный',
  magic: 'Волшебный',
  rare: 'Редкий',
  unique: 'Уникальный',
  gem: 'Камень',
  currency: 'Валюта',
  unknown: 'Неизвестно',
};

const CATEGORY_LABEL: Record<string, string> = {
  weapon: 'Оружие',
  armour: 'Доспехи',
  offhand: 'Оффхенд',
  jewellery: 'Бижутерия',
  flask: 'Флакон',
  charm: 'Оберег',
  jewel: 'Самоцвет',
  gem: 'Камень умения',
  currency: 'Валюта',
  waystone: 'Путевой камень',
  tablet: 'Плитка',
  trap: 'Ловушка',
  relic: 'Реликвия',
  quest: 'Квестовый предмет',
  unknown: 'Неизвестно',
};

const SOURCE_LABEL: Record<string, string> = {
  explicit: 'Свойство',
  implicit: 'Имплисит',
  unique: 'Уникальное',
  enchantment: 'Улучшение',
  corrupted: 'Осквернение',
  rune: 'Руна',
  unknown: 'Неизвестно',
};

const KIND_LABEL: Record<string, string> = {
  prefix: 'Префикс',
  suffix: 'Суффикс',
};

const STATE_LABEL: Record<string, string> = {
  fractured: 'расколото',
  crafted: 'ремесленное',
  desecrated: 'очернено',
  sanctified: 'освящено',
  unmodifiable: 'неизменяемо',
};

const FLAG_LABEL: Record<string, string> = {
  corrupted: 'Осквернено',
  doubleCorrupted: 'Дважды осквернено',
  fractured: 'Расколотый предмет',
  desecrated: 'Очернено',
  sanctified: 'Освящено',
  mirrored: 'Отзеркалено',
  split: 'Разделено',
  unmodifiable: 'Неизменяемо',
  unidentified: 'Неопознано',
};

const REQUIREMENT_LABEL: Record<string, string> = {
  level: 'Уровень',
  str: 'Сила',
  dex: 'Ловкость',
  int: 'Интеллект',
  unknown: 'Требование',
};

const EMPTY_HTML = `
  <div class="empty">
    <strong>Вставь текст предмета</strong>
    <span>Скопируй предмет в игре через Ctrl+C или Ctrl+Alt+C и вставь в поле слева. Разбор появится здесь.</span>
  </div>
`;

let currentJson = '';

function escapeHtml(value: unknown): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return String(value ?? '').replace(/[&<>"']/g, (character) => map[character] ?? character);
}

function setStatus(text: string): void {
  status.textContent = text;
}

function render(): void {
  const raw = textarea.value;

  if (!raw.trim()) {
    currentJson = '';
    result.innerHTML = EMPTY_HTML;
    setStatus('');
    return;
  }

  const parsed = parseItemText(raw, 'ru');
  if (!parsed.ok || !parsed.item) {
    currentJson = '';
    const reason = parsed.warnings.join('; ') || 'не удалось разобрать текст';
    result.innerHTML = `<div class="error"><strong>Не удалось разобрать предмет.</strong><br>${escapeHtml(reason)}</div>`;
    setStatus('Ошибка разбора');
    return;
  }

  currentJson = JSON.stringify(parsed.item, null, 2);
  result.innerHTML = renderItem(parsed.item, currentJson);

  const parts = [
    `${parsed.item.modifiers.length} мод.`,
    `${parsed.item.runes.length} рун`,
  ];
  if (parsed.warnings.length > 0) parts.push(`${parsed.warnings.length} предупр.`);
  setStatus(parts.join(' · '));
}

function renderItem(item: ParsedItem, jsonText: string): string {
  const displayName = item.name ?? item.baseType ?? item.itemClass;
  const baseLine =
    item.name && item.baseType ? `<div class="item-base">${escapeHtml(item.baseType)}</div>` : '';

  const meta: string[] = [
    `<span class="chip">${escapeHtml(item.itemClass)}</span>`,
    `<span class="chip">${escapeHtml(CATEGORY_LABEL[item.category] ?? item.category)}</span>`,
  ];
  if (item.itemLevel !== undefined) meta.push(`<span class="chip">ilvl ${item.itemLevel}</span>`);
  if (item.quality !== undefined) {
    const qualityType = item.qualityType ? ` · ${escapeHtml(item.qualityType)}` : '';
    meta.push(`<span class="chip">качество ${item.quality}%${qualityType}</span>`);
  }
  if (item.waystoneTier !== undefined) meta.push(`<span class="chip">тир ${item.waystoneTier}</span>`);
  if (item.sockets.length > 0) {
    meta.push(`<span class="chip">сокеты ${escapeHtml(item.sockets.join(' '))}</span>`);
  }

  const flagChips = Object.entries(item.flags)
    .filter(([, value]) => value)
    .map(([key]) => `<span class="chip flag">${escapeHtml(FLAG_LABEL[key] ?? key)}</span>`)
    .join('');

  const properties = item.properties.length > 0
    ? block(
        'Свойства',
        `<div class="kv">${item.properties
          .map(
            (property) => `
              <div class="kv-row">
                <span>${escapeHtml(property.label)}</span>
                <span class="kv-val">${escapeHtml(property.values.join(', '))}${property.augmented ? '<span class="mini">aug</span>' : ''}</span>
              </div>`,
          )
          .join('')}</div>`,
      )
    : '';

  const requirements = item.requirements.length > 0
    ? block(
        'Требования',
        `<div class="kv">${item.requirements
          .map(
            (requirement) => `
              <div class="kv-row">
                <span>${escapeHtml(REQUIREMENT_LABEL[requirement.key] ?? requirement.key)}</span>
                <span class="kv-val">${requirement.value}${requirement.unmet ? '<span class="mini bad">не выполнено</span>' : ''}${requirement.augmented ? '<span class="mini">aug</span>' : ''}</span>
              </div>`,
          )
          .join('')}</div>`,
      )
    : '';

  const statsBlocks =
    properties && requirements
      ? `<div class="two-col">${properties}${requirements}</div>`
      : properties || requirements;

  const advice =
    item.category === 'weapon' ||
    item.category === 'armour' ||
    item.category === 'offhand' ||
    item.category === 'jewellery' ||
    item.category === 'flask' ||
    item.category === 'charm' ||
    item.category === 'jewel' ||
    item.category === 'waystone' ||
    item.category === 'tablet' ||
    item.category === 'trap' ||
    item.category === 'relic'
      ? analyzeCraft(item, poolFor(item) ?? undefined)
      : null;

  const modifiers = item.modifiers.length > 0
    ? `<section class="block"><h3>Моды</h3><div class="mods">${item.modifiers
        .map((modifier) => renderModifier(modifier))
        .join('')}</div></section>`
    : '';

  const grantedSkills = item.grantedSkills.length > 0
    ? block(
        'Дарует умения',
        `<ul class="stat-list">${item.grantedSkills
          .map((skill) => `<li><span class="stat-text">${escapeHtml(skill)}</span></li>`)
          .join('')}</ul>`,
      )
    : '';

  const runes = item.runes.length > 0
    ? block('Руны', `<ul class="stat-list">${item.runes.map((line) => statLine(line)).join('')}</ul>`)
    : '';

  const flavour = item.flavourText?.length
    ? `<blockquote class="flavour">${item.flavourText.map((line) => escapeHtml(line)).join('<br>')}</blockquote>`
    : '';

  const description = item.description?.length
    ? block('Описание', `<div>${item.description.map((line) => escapeHtml(line)).join('<br>')}</div>`)
    : '';

  const warnings = item.warnings.length > 0
    ? `<div class="alert warn"><strong>Предупреждения</strong><ul>${item.warnings
        .map((warning) => `<li>${escapeHtml(warning)}</li>`)
        .join('')}</ul></div>`
    : '';

  const unknown = item.unknownLines.length > 0
    ? `<div class="alert unknown"><strong>Не распознано</strong><ul>${item.unknownLines
        .map((line) => `<li>${escapeHtml(line)}</li>`)
        .join('')}</ul></div>`
    : '';

  return `
    <article class="item-card">
      <header class="item-header">
        <div class="rarity ${escapeHtml(item.rarity)}">${escapeHtml(RARITY_LABEL[item.rarity] ?? item.rarity)}</div>
        <h2 class="item-name">${escapeHtml(displayName)}</h2>
        ${baseLine}
        <div class="chip-row">${meta.join('')}</div>
      </header>

      ${flagChips ? `<div class="chip-row">${flagChips}</div>` : ''}
      ${statsBlocks}
      ${advice ? renderAdvice(advice) : ''}
      ${modifiers}
      ${grantedSkills}
      ${runes}
      ${flavour}
      ${description}
      ${warnings}
      ${unknown}
      ${jsonBlock(jsonText)}
    </article>
  `;
}

function renderAdvice(advice: CraftAdvice): string {
  const profile = `<span class="advice-profile">${escapeHtml(advice.profile)}</span>`;
  const warnings = advice.warnings.length
    ? `<div class="advice-warnings">${advice.warnings.map((warning) => `<div>${escapeHtml(warning)}</div>`).join('')}</div>`
    : '';

  if (!advice.supported) {
    return `
      <section class="block advice advice-unsupported">
        <h3>Совет по крафту ${profile}</h3>
        <p class="advice-summary">${escapeHtml(advice.summary)}</p>
        ${warnings}
      </section>
    `;
  }

  const counts = `
    <div class="advice-counts">
      <span class="advice-count good">целевых: ${advice.counts.good}</span>
      <span class="advice-count neutral">нейтральных: ${advice.counts.neutral}</span>
      <span class="advice-count bad">мусорных: ${advice.counts.bad}</span>
      <span class="advice-count">открыто: P${advice.counts.openPrefixes} / S${advice.counts.openSuffixes}</span>
    </div>
  `;

  const steps = advice.steps.length
    ? `<ol class="advice-steps">${advice.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`
    : '';

  const targets = `
    <div class="advice-targets">
      <div>
        <h4>Целевые префиксы</h4>
        <ul>${advice.targetPrefixes.map((target) => `<li>${escapeHtml(target)}</li>`).join('')}</ul>
      </div>
      <div>
        <h4>Целевые суффиксы</h4>
        <ul>${advice.targetSuffixes.map((target) => `<li>${escapeHtml(target)}</li>`).join('')}</ul>
      </div>
    </div>
  `;

  const mods = advice.mods.length
    ? `<div class="advice-mods">${advice.mods
        .map(
          (mod) => `
            <div class="advice-mod">
              <span class="advice-verdict ${escapeHtml(mod.verdict)}">${
                mod.verdict === 'good'
                  ? 'хороший'
                  : mod.verdict === 'bad'
                    ? 'мусор'
                    : 'нейтральный'
              }</span>
              <span class="advice-mod-kind">${mod.kind === 'prefix' ? 'P' : 'S'}${mod.tier !== undefined ? ` · тир ${mod.tier}` : ''}</span>
              <span class="advice-mod-text">${escapeHtml(mod.text)}</span>
            </div>`,
        )
        .join('')}</div>`
    : '';

  return `
    <section class="block advice">
      <h3>Совет по крафту ${profile}</h3>
      <p class="advice-summary">${escapeHtml(advice.summary)}</p>
      ${counts}
      ${steps}
      ${mods}
      ${targets}
      ${warnings}
    </section>
  `;
}

function renderModifier(group: ModifierGroup): string {
  const titleParts = [SOURCE_LABEL[group.source] ?? group.source];
  if (group.kind !== 'none') titleParts.push(KIND_LABEL[group.kind] ?? group.kind);

  const affixName = group.affixName
    ? `<span class="affix-name">«${escapeHtml(group.affixName)}»</span>`
    : '';
  const tier = group.tier !== undefined ? `<span class="tag tier">Тир ${group.tier}</span>` : '';
  const annotation = group.annotation
    ? `<span class="tag annotation">${escapeHtml(group.annotation)}</span>`
    : '';
  const states = group.states
    .filter((state) => state !== 'unknown')
    .map((state) => `<span class="tag state">${escapeHtml(STATE_LABEL[state] ?? state)}</span>`)
    .join('');
  const tags = group.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
  const lines = group.lines.map((line) => statLine(line)).join('');

  return `
    <div class="mod-group ${escapeHtml(group.source)}">
      <div class="mod-head">
        <span class="mod-title">${escapeHtml(titleParts.join(' · '))}</span>
        ${affixName}${tier}${annotation}${states}${tags}
      </div>
      <ul class="stat-list">${lines || '<li><span class="stat-text">—</span></li>'}</ul>
    </div>
  `;
}

function statLine(line: StatLine): string {
  const roll = formatValues(line.values);
  return `<li>
    <span class="stat-text">${escapeHtml(line.text)}</span>
    ${roll ? `<span class="roll">${escapeHtml(roll)}</span>` : ''}
    ${line.fixedValue ? '<span class="tag">фикс.</span>' : ''}
  </li>`;
}

function formatValues(values: ModValue[]): string {
  return values
    .map((value) => {
      if (value.rolled === null) {
        if (value.min !== undefined && value.max !== undefined) {
          return `(${value.min}–${value.max})`;
        }
        return '?';
      }
      if (value.min !== undefined && value.max !== undefined) {
        return `${value.rolled} (${value.min}–${value.max})`;
      }
      return String(value.rolled);
    })
    .join(' · ');
}

function block(title: string, body: string): string {
  return `<section class="block"><h3>${escapeHtml(title)}</h3>${body}</section>`;
}

function jsonBlock(jsonText: string): string {
  return `
    <details class="json">
      <summary>JSON для отладки</summary>
      <div class="json-actions">
        <button class="btn small" type="button" data-copy-json>Скопировать JSON</button>
      </div>
      <pre>${escapeHtml(jsonText)}</pre>
    </details>
  `;
}

async function pasteFromClipboard(): Promise<void> {
  try {
    const text = window.craft
      ? await window.craft.readClipboard()
      : await navigator.clipboard.readText();
    if (!text.trim()) {
      setStatus('Буфер пуст');
      return;
    }
    textarea.value = text;
    render();
    textarea.focus();
  } catch {
    setStatus('Не удалось прочитать буфер');
  }
}

async function copyJson(button: HTMLElement): Promise<void> {
  if (!currentJson) return;
  try {
    if (window.craft) {
      await window.craft.writeClipboard(currentJson);
    } else {
      await navigator.clipboard.writeText(currentJson);
    }
    const previous = button.textContent;
    button.textContent = 'Скопировано';
    window.setTimeout(() => {
      button.textContent = previous;
    }, 1200);
  } catch {
    setStatus('Не удалось скопировать JSON');
  }
}

textarea.addEventListener('input', render);

pasteButton.addEventListener('click', () => {
  void pasteFromClipboard();
});

clearButton.addEventListener('click', () => {
  textarea.value = '';
  render();
  textarea.focus();
});

result.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-copy-json]');
  if (target) void copyJson(target);
});

if (window.craft?.onCapture) {
  window.craft.onCapture((text) => {
    if (!text) {
      setStatus('Не удалось скопировать предмет. Наведи курсор на предмет в игре и повтори.');
      return;
    }
    textarea.value = text;
    render();
    textarea.focus();
  });
}

initSettings();
render();
