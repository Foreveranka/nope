# GitHub and Vercel

Repository: https://github.com/Foreveranka/veil-procurement (private).
Vercel project: veil-procurement, scope omermetehanizal-9130s-projects.

The Vercel GitHub integration follows main for production. Push source changes to main; Vercel builds the same commit with `node scripts/build-web.mjs`. Other branch deployment behavior follows project settings.

Publication is static: landing at `/`, local-client explanation at `/app`, recorded synthetic local execution evidence at `/demo`. Only explicit web assets and sanitized public evidence enter dist. `/api/demo` and `/api/jobs` are NOT hosted APIs. The native Python/Concrete, MP-SPDZ and Rust/NEAR sandbox remain local. No production payment rail is enabled.

Never commit .env*, .vercel, runtime, wallet/private keys, dependencies or native build directories. Git excludes them. New local evidence must pass `scripts/archive-integration.py <runtime-run>` before inclusion. Its hash and receipt checks are local consistency checks, not a public execution proof.

To update: run relevant tests; build the static bundle; review the Git diff; commit and push main. Confirm Vercel READY and the expected commit SHA. A local edit without a push does not deploy.

First Git-triggered production deployment verified READY, source=git, commit `3b1c038a3e463805debb86288e17a39b136a8d8f`. Public URL: https://veil-procurement.vercel.app . Evidence: `verification/deployment-first.json`.
