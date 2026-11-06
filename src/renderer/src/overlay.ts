/**
 * Рендерер отдельного окна-оверлея.
 *
 * Контракт с preload: window.craft.onCapture(callback: (text: string | null) => void).
 * Полученный сырой текст предмета разбирается тем же парсером, что и основное
 * окно, и рисуется компактной карточкой. Всё, что приходит из игры,
 * экранируется; внешних ресурсов нет.
 */

import { parseItemText } from '../../core/parser';
import { analyzeCraft } from '../../core/craft/advisor';
import type { CraftAdvice } from '../../core/craft/advisor';
import { poolFor } from '../../core/target/pools';
import type { ActivePlan, StrategyResult, TargetCheck, TargetReport } from '../../core/target/planner';
import type { ModifierGroup, ModValue, ParsedItem, StatLine } from '../../core/types';

const RARITY_LABEL: Record<string, string> = {
  normal: 'Обычный',
  magic: 'Волшебный',
  rare: 'Редкий',
  unique: 'Уникальный',
  gem: 'Камень',
  currency: 'Валюта',
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
  desecrated: 'очернено',
  crafted: 'ремесленное',
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

/** Горячие клавиши должны совпадать с src/main/index.ts. */
const CAPTURE_HOTKEY = 'Alt+F';
const HIDE_HOTKEY = 'Alt+Shift+F';

function queryRequired<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Не найден элемент: ${selector}`);
  return element;
}

const root = queryRequired<HTMLElement>('#ov-root');
const minimizeButton = document.querySelector<HTMLButtonElement>('#ov-minimize');
const closeButton = document.querySelector<HTMLButtonElement>('#ov-close');

minimizeButton?.addEventListener('click', () => window.craft.hideOverlay());
closeButton?.addEventListener('click', () => window.craft.quitApp());

// Ручной drag: окно неактивируемое (focusable:false), поэтому нативный
// -webkit-app-region: drag на Windows не двигает его. Двигаем через IPC.
let dragging = false;
let lastDragX = 0;
let lastDragY = 0;

const titlebar = document.querySelector<HTMLElement>('#ov-titlebar');
titlebar?.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  const target = event.target;
  if (target instanceof Element && target.closest('button')) return;
  dragging = true;
  lastDragX = event.screenX;
  lastDragY = event.screenY;
  event.preventDefault();
});

window.addEventListener('mousemove', (event) => {
  if (!dragging) return;
  const dx = event.screenX - lastDragX;
  const dy = event.screenY - lastDragY;
  lastDragX = event.screenX;
  lastDragY = event.screenY;
  if (dx !== 0 || dy !== 0) window.craft.moveOverlay(dx, dy);
});

window.addEventListener('mouseup', () => {
  dragging = false;
});

/** Экранирует любой текст из игры перед вставкой через innerHTML. */
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

function chip(text: string, extraClass = ''): string {
  const className = extraClass ? `ov-chip ${extraClass}` : 'ov-chip';
  return `<span class="${className}">${escapeHtml(text)}</span>`;
}

function block(title: string, body: string): string {
  return `<section class="ov-block"><h2 class="ov-block-title">${escapeHtml(title)}</h2>${body}</section>`;
}

function show(html: string, variant = ''): void {
  const className = variant ? `ov-panel ${variant}` : 'ov-panel';
  root.innerHTML = `<div class="${className}">${html}</div>`;
}

function renderIdle(): void {
  show(`
    <div class="ov-state">
      <div class="ov-state-title">Ожидание предмета</div>
      <div class="ov-state-text">
        Наведи курсор на предмет в игре и нажми
        <span class="ov-kbd">${escapeHtml(CAPTURE_HOTKEY)}</span> — карточка появится здесь.
      </div>
      <div class="ov-state-text ov-state-hint">
        <span class="ov-kbd">${escapeHtml(HIDE_HOTKEY)}</span> — скрыть оверлей.
      </div>
    </div>
  `);
}

function renderCaptureError(reason?: string): void {
  const detail = reason ? `<div class="ov-reason">${escapeHtml(reason)}</div>` : '';
  show(
    `
      <div class="ov-state ov-error">
        <div class="ov-state-title">Не удалось получить предмет</div>
        <div class="ov-state-text">
          Наведи курсор на предмет в игре и повтори
          <span class="ov-kbd">${escapeHtml(CAPTURE_HOTKEY)}</span>.
        </div>
        ${detail}
      </div>
    `,
    'ov-panel-error',
  );
}

function handleCapture(text: string | null): void {
  if (text === null) {
    renderCaptureError('Предмет не попал в буфер обмена.');
    return;
  }

  try {
    const parsed = parseItemText(text, 'ru');
    if (!parsed.ok || !parsed.item) {
      const reason = parsed.warnings.join('; ') || 'Не удалось разобрать текст предмета.';
      renderCaptureError(reason);
      return;
    }
    renderItem(parsed.item);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Неизвестная ошибка разбора.';
    renderCaptureError(reason);
  }
}

function renderItem(item: ParsedItem): void {
  const rarityClass = `ov-rarity-${item.rarity}`;
  const name = item.name ?? item.baseType ?? item.itemClass;

  const baseLine =
    item.name && item.baseType ? `<div class="ov-base">${escapeHtml(item.baseType)}</div>` : '';

  const chips: string[] = [];
  if (item.itemClass) chips.push(chip(item.itemClass));
  if (item.itemLevel !== undefined) chips.push(chip(`ilvl ${item.itemLevel}`));
  if (item.quality !== undefined) {
    const qualityType = item.qualityType ? ` · ${item.qualityType}` : '';
    chips.push(chip(`качество ${item.quality}%${qualityType}`));
  }
  if (item.waystoneTier !== undefined) chips.push(chip(`тир ${item.waystoneTier}`));
  if (item.sockets.length > 0) chips.push(chip(`сокеты ${item.sockets.join(' ')}`));

  const flagChips = Object.entries(item.flags)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => chip(FLAG_LABEL[key] ?? key, 'ov-flag'));

  const meta =
    chips.length + flagChips.length > 0
      ? `<div class="ov-chips">${chips.join('')}${flagChips.join('')}</div>`
      : '';

  const properties =
    item.properties.length > 0
      ? block(
          'Свойства',
          `<div class="ov-kv">${item.properties
            .map(
              (property) => `
                <div class="ov-kv-row">
                  <span class="ov-kv-label">${escapeHtml(property.label)}</span>
                  <span class="ov-kv-value">${escapeHtml(property.values.join(', '))}${property.augmented ? '<span class="ov-mini">aug</span>' : ''}</span>
                </div>`,
            )
            .join('')}</div>`,
        )
      : '';

  const requirements =
    item.requirements.length > 0
      ? block(
          'Требования',
          `<div class="ov-kv">${item.requirements
            .map(
              (requirement) => `
                <div class="ov-kv-row">
                  <span class="ov-kv-label">${escapeHtml(REQUIREMENT_LABEL[requirement.key] ?? requirement.key)}</span>
                  <span class="ov-kv-value">${requirement.value}${requirement.unmet ? '<span class="ov-mini ov-mini-bad">не выполнено</span>' : ''}${requirement.augmented ? '<span class="ov-mini">aug</span>' : ''}</span>
                </div>`,
            )
            .join('')}</div>`,
        )
      : '';

  let stats = '';
  if (properties && requirements) {
    stats = `<div class="ov-cols">${properties}${requirements}</div>`;
  } else {
    stats = properties || requirements;
  }

  const modifiers =
    item.modifiers.length > 0
      ? block(
          'Моды',
          `<div class="ov-mods">${item.modifiers.map((modifier) => renderModifier(modifier)).join('')}</div>`,
        )
      : '';

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

  const grantedSkills =
    item.grantedSkills.length > 0
      ? block(
          'Дарует умения',
          `<ul class="ov-stats">${item.grantedSkills
            .map((skill) => `<li class="ov-stat"><span class="ov-stat-text">${escapeHtml(skill)}</span></li>`)
            .join('')}</ul>`,
        )
      : '';

  const runes =
    item.runes.length > 0
      ? block('Руны', `<ul class="ov-stats">${item.runes.map((line) => statLine(line)).join('')}</ul>`)
      : '';

  const flavour =
    item.flavourText && item.flavourText.length > 0
      ? `<blockquote class="ov-flavour">${item.flavourText.map((line) => escapeHtml(line)).join('<br>')}</blockquote>`
      : '';

  const description =
    item.description && item.description.length > 0
      ? block(
          'Описание',
          `<div class="ov-description">${item.description.map((line) => escapeHtml(line)).join('<br>')}</div>`,
        )
      : '';

  show(`
    <div class="ov-head">
      <div class="ov-rarity ${rarityClass}">${escapeHtml(RARITY_LABEL[item.rarity] ?? item.rarity)}</div>
      <h1 class="ov-name ${rarityClass}">${escapeHtml(name)}</h1>
      ${baseLine}
      ${meta}
    </div>
    <div class="ov-body">
      ${advice ? renderAdvice(advice) : ''}
      ${stats}
      ${modifiers}
      ${grantedSkills}
      ${runes}
      ${flavour}
      ${description}
    </div>
  `);
}

function renderAdvice(advice: CraftAdvice): string {
  const profile = escapeHtml(advice.profile);
  const warnings = advice.warnings.length
    ? `<div class="ov-advice-warnings">${advice.warnings.map((warning) => `<div>${escapeHtml(warning)}</div>`).join('')}</div>`
    : '';

  if (!advice.supported) {
    return `
      <div class="ov-advice ov-advice-off">
        <div class="ov-advice-head">Совет по крафту · ${profile}</div>
        <div class="ov-advice-summary">${escapeHtml(advice.summary)}</div>
        ${warnings}
      </div>
    `;
  }

  const steps = advice.steps
    .slice(0, 5)
    .map((step) => `<li>${escapeHtml(step)}</li>`)
    .join('');

  const targets = `
    <div class="ov-advice-targets">
      <div><b>P:</b> ${advice.targetPrefixes.map((target) => escapeHtml(target)).join(' · ')}</div>
      <div><b>S:</b> ${advice.targetSuffixes.map((target) => escapeHtml(target)).join(' · ')}</div>
    </div>
  `;

  return `
    <div class="ov-advice">
      <div class="ov-advice-head">Совет по крафту · ${profile}</div>
      <div class="ov-advice-summary">${escapeHtml(advice.summary)}</div>
      <ol class="ov-advice-steps">${steps}</ol>
      ${targets}
      ${warnings}
    </div>
  `;
}

function renderModifier(group: ModifierGroup): string {
  const source = SOURCE_LABEL[group.source] ?? group.source;
  const kind = group.kind === 'none' ? '' : KIND_LABEL[group.kind] ?? group.kind;
  const title = kind ? `${source} · ${kind}` : source;

  const affixName = group.affixName
    ? `<span class="ov-affix">«${escapeHtml(group.affixName)}»</span>`
    : '';
  const tier =
    group.tier !== undefined ? `<span class="ov-tag ov-tag-tier">тир ${group.tier}</span>` : '';
  const annotation = group.annotation
    ? `<span class="ov-tag ov-tag-annotation">${escapeHtml(group.annotation)}</span>`
    : '';
  const states = group.states
    .filter((state) => state !== 'unknown')
    .map((state) => `<span class="ov-tag ov-tag-state">${escapeHtml(STATE_LABEL[state] ?? state)}</span>`)
    .join('');

  const lines =
    group.lines.length > 0
      ? `<ul class="ov-stats">${group.lines.map((line) => statLine(line)).join('')}</ul>`
      : '<div class="ov-stat-empty">—</div>';

  return `
    <div class="ov-mod ov-mod-${escapeHtml(group.source)}">
      <div class="ov-mod-head">
        <span class="ov-mod-source">${escapeHtml(title)}</span>
        ${affixName}${tier}${annotation}${states}
      </div>
      ${lines}
    </div>
  `;
}

function statLine(line: StatLine): string {
  const roll = formatValues(line.values);
  return `<li class="ov-stat">
    <span class="ov-stat-text">${escapeHtml(line.text)}</span>
    ${roll ? `<span class="ov-roll">${escapeHtml(roll)}</span>` : ''}
    ${line.fixedValue ? '<span class="ov-tag">фикс.</span>' : ''}
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

renderIdle();

const bridge = window.craft;
function formatPrice(exalted: number, divinePrice: number | null): string {
  if (divinePrice && exalted >= divinePrice) return `${(exalted / divinePrice).toFixed(1)} div`;
  return `${exalted < 10 ? exalted.toFixed(1) : Math.round(exalted)} ex`;
}

function formatCount(value: number): string {
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}

function formatShare(share: number): string {
  return `${(share * 100).toFixed(share < 0.01 ? 2 : 1)}%`;
}

function formatChance(strategy: StrategyResult): string {
  if (strategy.probability === 0) return `< ${(100 / strategy.trials).toFixed(2)}%`;
  return formatShare(strategy.probability);
}

function stepOdds(strategy: StrategyResult): string {
  return strategy.steps
    .filter((step) => step.chance !== undefined)
    .map((step) => `${step.title}: ${formatShare(step.chance ?? 0)}`)
    .join(' → ');
}

function strategyRow(strategy: StrategyResult, path: string, divinePrice: number | null): string {
  const cost =
    strategy.costPerSuccess === null
      ? 'нет оценки'
      : `${strategy.incompleteCost || strategy.basePriceMissing ? 'от ' : ''}${formatPrice(strategy.costPerSuccess, divinePrice)}`;
  const bases =
    strategy.basesPerSuccess !== null && strategy.basesPerSuccess > 1
      ? `Риск потерять предмет ${((1 - strategy.probability) * 100).toFixed(1)}%, в среднем заготовок на успех: ${formatCount(strategy.basesPerSuccess)}${strategy.basePriceMissing ? ' (их цена не задана)' : ''}`
      : '';
  const uses = strategy.uses
    .map((use) => `${use.label} × ${use.average.toFixed(1)}${use.price === null ? ' (нет цены)' : ''}`)
    .join(', ');
  return `
    <li class="ov-strategy">
      <div class="ov-strategy-head">
        <span>${escapeHtml(strategy.label)}</span>
        <span class="ov-strategy-value">${escapeHtml(formatChance(strategy))} · ${escapeHtml(cost)}</span>
      </div>
      <div class="ov-strategy-uses">${escapeHtml(uses)}</div>
      ${stepOdds(strategy) ? `<div class="ov-strategy-uses">Шанс сферы: ${escapeHtml(stepOdds(strategy))}</div>` : ''}
      ${bases ? `<div class="ov-strategy-risk">${escapeHtml(bases)}</div>` : ''}
      <div class="ov-strategy-foot">
        ${strategy.tag ? `<span class="ov-strategy-tag">${escapeHtml(strategy.tag)}</span>` : '<span></span>'}
        <button class="ov-btn" type="button" data-path="${escapeHtml(path)}">Выбрать</button>
      </div>
    </li>
  `;
}

const TARGET_STATUS: Record<string, string> = {
  have: 'есть',
  need: 'нужен',
  special: 'особый',
  impossible: 'нельзя',
};
const TARGET_VERDICT: Record<string, string> = {
  ready: 'уже подходит',
  reachable: 'достижимо',
  partial: 'частично достижимо',
  unreachable: 'нельзя изменить',
};

function targetBlock(report: TargetReport, reportIndex: number, divinePrice: number | null): string {
  const mods = report.mods
    .map(
      (mod) =>
        `<li class="ov-target-mod ${escapeHtml(mod.status)}">${escapeHtml(TARGET_STATUS[mod.status])}: ${escapeHtml(mod.text)}${mod.note ? ` <span class="ov-target-note">(${escapeHtml(mod.note)})</span>` : ''}</li>`,
    )
    .join('');
  const reasons = report.reasons
    .map((reason) => `<div class="ov-state-text">${escapeHtml(reason)}</div>`)
    .join('');
  const strategies = report.strategies
    .map((strategy, index) => strategyRow(strategy, `${reportIndex}:${index}`, divinePrice))
    .join('');
  return block(
    `${report.targetName} · ${TARGET_VERDICT[report.verdict]}`,
    `${reasons}<ul class="ov-target-mods">${mods}</ul>${strategies ? `<ul class="ov-strategies">${strategies}</ul><div class="ov-state-hint">Шанс на один предмет · расход на успех с учётом потерянных заготовок</div>` : ''}`,
  );
}

let currentCheck: TargetCheck | null = null;
let activePlan: ActivePlan | null = null;

function planBanner(): string {
  if (!activePlan) return '';
  return `
    <div class="ov-plan-banner">
      <span>Идёт план: ${escapeHtml(activePlan.label)}</span>
      <button class="ov-btn" type="button" data-action="open-plan">Открыть</button>
    </div>
  `;
}

function renderTargetCheck(check: TargetCheck): void {
  currentCheck = check;
  if (check.pending) {
    show('<div class="ov-state"><div class="ov-state-title">Считаю пути крафта…</div></div>');
    return;
  }
  if (check.error) {
    renderCaptureError(check.error);
    return;
  }
  const note = check.pricesNote
    ? `<div class="ov-state-text ov-error">${escapeHtml(check.pricesNote)}</div>`
    : '';
  show(
    planBanner() +
      note +
      check.reports.map((report, index) => targetBlock(report, index, check.divinePrice)).join(''),
  );
}

function stepRow(step: ActivePlan['steps'][number], index: number): string {
  const attempts = step.repeat ? `<span class="ov-plan-attempts">попыток: ${step.attempts}</span>` : '';
  const hint =
    step.state === 'failed'
      ? `<div class="ov-plan-hint">${step.repeat ? 'Повтори шаг или вернись к шагу с удалением мода.' : 'Нажми Alt+G на предмете: расчёт покажет новые пути.'}</div>`
      : '';
  const actions =
    step.state === 'done'
      ? `<button class="ov-btn" type="button" data-step="${index}" data-result="todo">Отменить</button>`
      : `<button class="ov-btn ov-btn-ok" type="button" data-step="${index}" data-result="done">Готово</button>
         <button class="ov-btn" type="button" data-step="${index}" data-result="failed">Не вышло</button>`;
  return `
    <li class="ov-plan-step ${escapeHtml(step.state)}">
      <div class="ov-plan-title">${index + 1}. ${escapeHtml(step.title)} ${attempts}</div>
      ${step.chance !== undefined ? `<div class="ov-plan-chance">Шанс за применение: ${formatShare(step.chance)} (${escapeHtml(step.chanceOf ?? '')})</div>` : ''}
      ${step.detail ? `<div class="ov-plan-detail">${escapeHtml(step.detail)}</div>` : ''}
      ${hint}
      <div class="ov-plan-actions">${actions}</div>
    </li>
  `;
}

function renderPlan(): void {
  if (!activePlan) return;
  const done = activePlan.steps.filter((step) => step.state === 'done').length;
  const total = activePlan.steps.length;
  show(`
    <section class="ov-block">
      <h2 class="ov-block-title">${escapeHtml(activePlan.targetName)}</h2>
      <div class="ov-plan-head">
        <span>${escapeHtml(activePlan.label)}</span>
        <span class="ov-strategy-value">${done} из ${total}</span>
      </div>
      <ol class="ov-plan-steps">${activePlan.steps.map(stepRow).join('')}</ol>
      ${done === total ? '<div class="ov-state-text">Все шаги пройдены. Проверь предмет через Alt+G.</div>' : ''}
      <div class="ov-plan-actions">
        ${currentCheck?.reports.length ? '<button class="ov-btn" type="button" data-action="back">К путям</button>' : ''}
        <button class="ov-btn" type="button" data-action="close-plan">Закрыть план</button>
      </div>
    </section>
  `);
}

function startPlan(path: string): void {
  const [reportIndex, strategyIndex] = path.split(':').map(Number);
  const report = currentCheck?.reports[reportIndex ?? -1];
  const strategy = report?.strategies[strategyIndex ?? -1];
  if (!report || !strategy) return;
  activePlan = {
    targetName: report.targetName,
    label: strategy.label,
    steps: strategy.steps.map((step) => ({ ...step, state: 'todo', attempts: 0 })),
  };
  void window.craft.savePlan(activePlan);
  renderPlan();
}

function markStep(index: number, result: string): void {
  const step = activePlan?.steps[index];
  if (!activePlan || !step) return;
  if (result === 'failed') step.attempts += 1;
  step.state = result === 'done' || result === 'failed' ? result : 'todo';
  void window.craft.savePlan(activePlan);
  renderPlan();
}

root.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLElement>('button');
  if (!button) return;
  const { path, step, result, action } = button.dataset;
  if (path) startPlan(path);
  if (step !== undefined && result) markStep(Number(step), result);
  if (action === 'open-plan') renderPlan();
  if (action === 'back' && currentCheck) renderTargetCheck(currentCheck);
  if (action === 'close-plan') {
    activePlan = null;
    void window.craft.savePlan(null);
    if (currentCheck) renderTargetCheck(currentCheck);
    else renderIdle();
  }
});

void window.craft?.getPlan?.().then((plan) => {
  activePlan = plan;
});

if (bridge && typeof bridge.onTargetResult === 'function') {
  bridge.onTargetResult((check) => renderTargetCheck(check));
}

if (bridge && typeof bridge.onCapture === 'function') {
  bridge.onCapture((text) => handleCapture(text));
} else {
  renderCaptureError('Мост preload (window.craft.onCapture) недоступен.');
}
