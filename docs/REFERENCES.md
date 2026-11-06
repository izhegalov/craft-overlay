# Справочные данные из `default-workspace`

Источник: `C:\Users\ggwpa\Documents\deepseek-harness\default-workspace` — отдельный воркспейс с материалами по PoE2. По условию пользователя его можно **читать и копировать, но нельзя редактировать**. Снимки скопированы 2026-11-05 в [`data/reference/`](../data/reference/).

> Это **не истина в последней инстанции**: данные могли устареть относительно текущего патча. Для парсера MVP они не обязательны, но пригодятся для канонизации, trade API и крафт-калькулятора.

Отдельно есть производные наборы [`data/bases.json`](../data/bases.json) и [`data/currency.json`](../data/currency.json) — их схема и источники описаны в [DATA.md](DATA.md).

## Что скопировано

| Файл | Размер | Что внутри | Где пригодится |
|---|---:|---|---|
| `data/reference/en-ru-map.json` | 146 КБ | 2166 пар `EN → RU`: предметы, базы, классы, статы, теги | канонизация RU→EN для trade API; словарь классов |
| `data/reference/ru-names.json` | 19 КБ | 300 пар `EN → RU`: уникальные предметы, руны, эссенции, валюты | перевод имён уникальных предметов |
| `data/reference/trade-items.json` | 182 КБ | Снимок `/api/trade2/data/items`: `result[]` — категории (`accessory`, …) с `entries[].type` | построение trade-запросов |
| `data/reference/trade-stats.json` | 834 КБ | Снимок `/api/trade2/data/stats`: `result[]` — группы статов, `entries[].id/text/type` | фильтры по модам в trade |
| `data/reference/mods-data.json` | 2.4 МБ | Моды по классам: `classes[].sections[].groups[].rows[]` с тиром/весом/описанием (RU) | крафт-калькулятор, проверка модов, веса |
| `data/reference/waystone-mods-ru.txt` | 5.7 КБ | 35 обычных + 17 очернённых модов путевых камней (RU), шаблоны `(min—max)` | проверка парсера waystone, regex-поиск |
| `data/reference/amulet-example.txt` | 186 Б | Маленький пример мода амулета | быстрый тест |

Форматы:

```jsonc
// trade-items.json
{ "result": [ { "id": "accessory", "label": "Accessories", "entries": [ { "type": "Crimson Amulet" } ] } ] }

// trade-stats.json
{ "result": [ { "id": "pseudo", "label": "Pseudo", "entries": [
  { "id": "pseudo.pseudo_total_cold_resistance", "text": "+#% total to Cold Resistance", "type": "pseudo" }
] } ] }

// mods-data.json
{ "classes": [ { "key": "Abyss_Tablet", "title": "Плитка · Бездна", "sections": [ {
  "key": "normal", "title": "Базовый", "groups": [ {
    "name": "Призывательский", "type": "prefix",
    "rows": [ { "n": "Призывательский", "lvl": 1, "g": "prefix", "w": 1, "d": "На карте можно встретить …" } ]
  } ]
} ] } ] }
```

## Что не копировалось, но полезно

| Путь в `default-workspace` | Что |
|---|---|
| `poe2-craft-guide\data\poe2-knowledge.md` | Конспект по игре: билды, фарм, ссылки (не про формат предметов) |
| `poe2-craft-guide\REGEX-RESEARCH.md` | Исследование regex-поиска в игре (пригодится для фильтров, не для парсера) |
| `poe2-craft-guide\tools\_site_with_weights.json` | ~1.2 МБ, моды с весами |
| `_poe2db_map.json`, `_poe2db_urls.json` | Маппинг/URL-ы poe2db |
| `_site_parsed.json`, `_site_with_weights.json` | Промежуточные данные сайта-гайда |

## Как использовать в проекте

1. **Сейчас (M1):** `waystone-mods-ru.txt` — как источник шаблонов модов без ролла и с диапазонами; проверить, что парсер не падает на строках вида `(-4—-3)%`.
2. **M2+:** `en-ru-map.json` — канонизация классов/баз/имён; `mods-data.json` — проверка распознанных модов и весов.
3. **M6 (trade):** `trade-items.json` / `trade-stats.json` — построение запросов; кэшировать локально, обновлять с API.

## Правила

- Источник не редактировать.
- Копии в `data/reference/` можно менять/обновлять, но при обновлении фиксировать дату и источник.
- Не тащить в репозиторий тысячи картинок и HTML из `default-workspace` — только нужные данные.
