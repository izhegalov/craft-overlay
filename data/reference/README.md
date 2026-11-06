# data/reference

Снимки справочных данных, скопированные из `C:\Users\ggwpa\Documents\deepseek-harness\default-workspace` (2026-11-05).

Источник можно читать/копировать, но нельзя редактировать. Эти копии — не эталон: данные могут устареть.

Описание файлов и как их использовать — в [docs/REFERENCES.md](../../docs/REFERENCES.md).

- `en-ru-map.json` — EN→RU словарь предметов/баз/статов;
- `ru-names.json` — EN→RU имена уникальных предметов, рун, валют;
- `trade-items.json`, `trade-stats.json` — снимки данных trade API;
- `mods-data.json` — моды по классам с весами (RU), собирается с poe2db (CC BY-NC-SA 3.0): `node scripts/build-mods.mjs`, снимок от 2026-11-06. У строки `x` — остальные строки гибрида, `t` — теги мода. Список классов и их подписи берутся из самого файла;
- `waystone-mods-ru.txt` — моды путевых камней (RU);
- `amulet-example.txt` — маленький пример.
