import type { BaseAdvice } from '../../core/target/planner';
import type { SettingsView } from './env';

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Не найден элемент: ${selector}`);
  return element;
}

export function initSettings(): void {
  if (!window.craft?.getSettings) return;

  const panel = required<HTMLElement>('#settings');
  const targetText = required<HTMLTextAreaElement>('#target-text');
  const targetError = required<HTMLElement>('#target-error');
  const targetList = required<HTMLElement>('#target-list');
  const tolerance = required<HTMLInputElement>('#tolerance');
  const league = required<HTMLInputElement>('#league');
  const priceRows = required<HTMLElement>('#price-rows');
  const pricesStatus = required<HTMLElement>('#prices-status');

  let manualPrices: Record<string, number> = {};
  // Расчёт идёт секунды, поэтому повторяется только при смене его входных данных.
  const bases = new Map<string, Promise<BaseAdvice | null>>();

  function baseLines(advice: BaseAdvice | null, divine: number | null): string[] {
    if (!advice) return ['Не удалось посчитать базу.'];
    const money = (value: number): string =>
      divine && value >= divine
        ? `${(value / divine).toFixed(1)} div`
        : `${value < 10 ? value.toFixed(1) : Math.round(value)} ex`;
    const chance = (value: number): string => `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
    const from = (incomplete: boolean): string => (incomplete ? 'от ' : '');
    return [
      `Уровень предмета от ${advice.itemLevel}.`,
      ...(advice.mustHave.length > 0
        ? [`Не крафтится, искать на базе: ${advice.mustHave.join('; ')}`]
        : []),
      advice.white
        ? `Белая база: ${chance(advice.white.probability)}, ${from(advice.white.incompleteCost)}${money(advice.white.cost)} на успех — ${advice.white.label}.`
        : 'С белой базы симуляция не собрала образец.',
      ...advice.options.map((option) => {
        const worth = option.maxPrice === null ? '' : `, брать дешевле ${money(option.maxPrice)}`;
        const rarity = option.rarity === 'magic' ? 'Волшебная' : 'Редкая';
        return `${rarity} с «${option.mods.join('» и «')}»: ${chance(option.probability)}, ${from(option.incompleteCost)}${money(option.cost)} на успех${worth} — ${option.label}.`;
      }),
    ];
  }

  function renderBases(box: HTMLElement, id: string, key: string, divine: number | null): void {
    box.textContent = 'Считаю, какую базу купить…';
    const advice = bases.get(key) ?? window.craft.getBases(id);
    bases.set(key, advice);
    void advice.then((result) => {
      box.replaceChildren(
        ...baseLines(result, divine).map((line) => {
          const row = document.createElement('div');
          row.textContent = line;
          return row;
        }),
      );
    });
  }

  function renderTargets(view: SettingsView): void {
    const divine = view.priceRows.find((row) => row.id === 'divine');
    targetList.replaceChildren(
      ...view.targets.map((target) => {
        const row = document.createElement('li');
        const text = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = `${target.name} · ${target.baseType}`;
        const mods = document.createElement('div');
        mods.className = 'target-mods';
        mods.textContent = target.mods.join('; ');
        const advice = document.createElement('div');
        advice.className = 'target-bases';
        text.append(title, mods, advice);
        renderBases(
          advice,
          target.id,
          JSON.stringify([target.id, target.basePrice, view.tolerancePct, view.pricesFetchedAt, view.priceRows]),
          divine?.manual ?? divine?.price ?? null,
        );

        const remove = document.createElement('button');
        remove.className = 'btn small';
        remove.type = 'button';
        remove.textContent = 'Удалить';
        remove.addEventListener('click', () => {
          void window.craft.removeTarget(target.id).then(render);
        });
        const price = document.createElement('label');
        price.className = 'target-price';
        price.textContent = 'Цена заготовки, ex';
        const priceInput = document.createElement('input');
        priceInput.type = 'number';
        priceInput.min = '0';
        priceInput.step = 'any';
        priceInput.value = target.basePrice === null ? '' : String(target.basePrice);
        priceInput.addEventListener('change', () => {
          const value = priceInput.value === '' ? null : Number(priceInput.value);
          void window.craft.setBasePrice(target.id, value).then(render);
        });
        price.append(priceInput);

        const actions = document.createElement('div');
        actions.className = 'target-actions';
        actions.append(price, remove);
        row.append(text, actions);
        return row;
      }),
    );
  }

  function renderPrices(view: SettingsView): void {
    manualPrices = Object.fromEntries(
      view.priceRows.flatMap((row) => (row.manual === null ? [] : [[row.id, row.manual]])),
    );
    priceRows.replaceChildren(
      ...view.priceRows.map((row) => {
        const line = document.createElement('tr');
        const label = document.createElement('td');
        label.textContent = row.label;
        const auto = document.createElement('td');
        auto.textContent = row.price === null ? '—' : row.price.toFixed(2);

        const manualCell = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = 'any';
        input.setAttribute('aria-label', `Цена вручную: ${row.label}`);
        input.value = row.manual === null ? '' : String(row.manual);
        input.addEventListener('change', () => {
          const value = Number(input.value);
          const { [row.id]: _removed, ...others } = manualPrices;
          void window.craft
            .updateSettings({
              manualPrices: input.value && value > 0 ? { ...others, [row.id]: value } : others,
            })
            .then(render);
        });
        manualCell.append(input);
        line.append(label, auto, manualCell);
        return line;
      }),
    );

    pricesStatus.textContent = view.pricesFetchedAt
      ? `Обновлено: ${new Date(view.pricesFetchedAt).toLocaleString('ru-RU')}`
      : 'Цены ещё не загружались';
  }

  function render(view: SettingsView): void {
    tolerance.value = String(view.tolerancePct);
    league.value = view.league;
    renderTargets(view);
    renderPrices(view);
  }

  required('#settings-open').addEventListener('click', () => {
    panel.hidden = false;
    void window.craft.getSettings().then(render);
  });
  required('#settings-close').addEventListener('click', () => {
    panel.hidden = true;
  });

  required('#target-add').addEventListener('click', () => {
    void window.craft.addTarget(targetText.value).then((result) => {
      if ('error' in result) {
        targetError.textContent = result.error;
        return;
      }
      targetError.textContent = '';
      targetText.value = '';
      render(result);
    });
  });

  tolerance.addEventListener('change', () => {
    void window.craft.updateSettings({ tolerancePct: Number(tolerance.value) }).then(render);
  });
  league.addEventListener('change', () => {
    void window.craft.updateSettings({ league: league.value }).then(render);
  });

  required('#prices-refresh').addEventListener('click', () => {
    pricesStatus.textContent = 'Загрузка…';
    void window.craft.refreshPrices().then(({ error, view }) => {
      render(view);
      if (error) pricesStatus.textContent = error;
    });
  });
}
