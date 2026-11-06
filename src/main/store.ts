import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ActivePlan } from '../core/target/planner';

export interface SavedTarget {
  id: string;
  text: string;
  /** Цена заготовки в Exalted: что теряется при неудачной попытке. */
  basePrice?: number;
}

export interface Settings {
  tolerancePct: number;
  league: string;
  targets: SavedTarget[];
  /** Цены в Exalted, заданные вручную: важнее загруженных. */
  manualPrices: Record<string, number>;
  prices: { league: string; fetchedAt: number; values: Record<string, number> } | null;
  activePlan: ActivePlan | null;
}

const MAX_TARGET_TEXT = 20000;
const MAX_PLAN_STEPS = 50;

export function defaultSettings(): Settings {
  return { tolerancePct: 20, league: 'Standard', targets: [], manualPrices: {}, prices: null, activePlan: null };
}

function positiveNumbers(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] > 0,
    ),
  );
}

function sanitizePlan(value: unknown): ActivePlan | null {
  const plan = value as Partial<ActivePlan> | null;
  if (typeof plan?.targetName !== 'string' || typeof plan.label !== 'string') return null;
  if (!Array.isArray(plan.steps) || plan.steps.length > MAX_PLAN_STEPS) return null;

  const steps = plan.steps.filter((step) => typeof step?.title === 'string');
  return {
    targetName: plan.targetName,
    label: plan.label,
    steps: steps.map((step) => ({
      title: step.title,
      ...(typeof step.detail === 'string' ? { detail: step.detail } : {}),
      ...(step.repeat === true ? { repeat: true } : {}),
      ...(typeof step.chance === 'number' && step.chance >= 0 && step.chance <= 1
        ? { chance: step.chance }
        : {}),
      ...(typeof step.chanceOf === 'string' ? { chanceOf: step.chanceOf } : {}),
      state: step.state === 'done' || step.state === 'failed' ? step.state : 'todo',
      attempts: Number.isInteger(step.attempts) && step.attempts > 0 ? step.attempts : 0,
    })),
  };
}

/** Граница доверия: файл настроек и данные из окна приводятся к Settings. */
export function sanitizeSettings(raw: unknown): Settings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Settings>;
  const defaults = defaultSettings();

  const tolerance = Number(source.tolerancePct);
  const league = typeof source.league === 'string' ? source.league.trim().slice(0, 100) : '';
  const targets = Array.isArray(source.targets)
    ? source.targets
        .filter(
          (entry): entry is SavedTarget =>
            typeof entry?.id === 'string' &&
            typeof entry?.text === 'string' &&
            entry.text.length <= MAX_TARGET_TEXT,
        )
        .map(({ id, text, basePrice }) => ({
          id,
          text,
          ...(typeof basePrice === 'number' && Number.isFinite(basePrice) && basePrice >= 0
            ? { basePrice }
            : {}),
        }))
    : [];
  const prices = source.prices;

  return {
    tolerancePct: Number.isFinite(tolerance)
      ? Math.min(100, Math.max(0, tolerance))
      : defaults.tolerancePct,
    league: league || defaults.league,
    targets,
    manualPrices: positiveNumbers(source.manualPrices),
    prices:
      prices && typeof prices.league === 'string' && typeof prices.fetchedAt === 'number'
        ? { league: prices.league, fetchedAt: prices.fetchedAt, values: positiveNumbers(prices.values) }
        : null,
    activePlan: sanitizePlan(source.activePlan),
  };
}

export function loadSettings(path: string): Settings {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return defaultSettings();
  }
  try {
    return sanitizeSettings(JSON.parse(text));
  } catch (error) {
    // Битый файл не затираем: в нём могут быть сохранённые образцы.
    console.error('Файл настроек повреждён, сохранён как .bad:', error);
    renameSync(path, `${path}.bad`);
    return defaultSettings();
  }
}

/** Запись через временный файл: сбой посреди записи не портит настройки. */
export function saveSettings(path: string, settings: Settings): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings, null, 2), 'utf8');
  renameSync(temporary, path);
}
