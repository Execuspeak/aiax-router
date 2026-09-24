# Benderbot launch branch

Benderbot's supervisor (`npm run supervise`) and `scripts/router.ps1` launch
this checkout on **`integration/benderbot-inference-hardening`**.

That branch is the one a plain question uses: one good model, not the full
review pipeline (`weight: light` in `src/core/pipeline.ts`).

`origin/main` currently has the one-model path (`b4e31bd`) but not the
inference-gateway hardening (`f757433`). This desk did not merge or push that
commit onto origin. The launcher pins the integration branch instead of
assuming `main`.
