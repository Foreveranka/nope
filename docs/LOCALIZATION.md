# Product languages and country selection

The active landing page, workspace routes and public result verifier support
Turkish, English, German, Spanish and French. Historical unlinked research/demo
pages are separate from the product navigation.

Initial automatic selection uses `/api/locale` and Vercel's documented
[`x-vercel-ip-country`](https://vercel.com/docs/headers/request-headers) header:
TR→tr, DE→de, ES→es, FR→fr, every other/unknown country→en. Browser language is
not used to override this rule. The application does not read, log, forward or
store the raw IP. The country endpoint returns only the language and explicitly
disables browser/CDN caching; it makes no third-party geolocation call.

A manual choice overrides automatic selection and is stored as a whitelisted
language code in `localStorage` under `nope.language`. Storage/geo failures use
English. English is also bundled with the core module; a missing optional
catalog cannot discard it or prevent startup, and catalog requests time out. The picker changes registered UI text/attributes in place. It never
reloads a page, reruns a job, submits a financial action or replaces form inputs.

`msg` marks built-in UI text; interpolation values remain data. Dynamic customer
names, titles, descriptions, goals, CSV cells, keys, addresses, amounts and public
proof JSON are not translated. Static translation runs only on the initial
product markup, before user content mounts; there is no global mutation observer
that scans future private data. Translations use text nodes/attributes rather
than HTML injection. Labels bind a dedicated text leaf so later language changes
cannot remove their associated inputs or button icons.

The two source catalogs are merged into `tr.json`; four complete translations
must contain the exact same key set and numbered interpolation placeholders.
`node scripts/check-locales.mjs` is a build gate. Public assets include exactly
the five final catalogs and an English core fallback generated from the same
English catalog; source catalogs, user data, credentials and local
runtime files are not part of the static language bundle.

Relevant checks are `tests/i18n.test.mjs`, `tests/locale.test.mjs` and existing
workspace/cryptographic regression tests. Country-header unit fixtures are not
claims of real requests from every country. Actual production checks are kept
separately in the local verification log.

After editing source/translation catalogs, run `node scripts/check-locales.mjs --write-tr` to regenerate the Turkish union and English core fallback, then run the normal build gate.
