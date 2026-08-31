# Nebul saturation test - 2026-08-27T17:34:10+00:00

Endpoint: POST https://api.inference.nebul.io/v1/messages?beta=true   Model: zai-org/GLM-5.2-FP8

Requests: 8 sent - 0 ok, 0 rejected with "failed to extract prompt from request body", 8 other failures.

Peak in-flight reached: 8

Token accounting: 0 fresh input, 0 served from cache (0.0%), 0 output. Actual spend this run: ~$0.00.



NOT REPRODUCED at these levels (peak in-flight 8).

Raise --ramp, --payload-kb or --max-tokens. Check the cache figure above first: if a large share was served from cache, the backend was never actually loaded and this run proves nothing.



x-ratelimit-* headers seen on any of the 8 responses: NONE


## Per-request log

| conc | phase | # | t+s | status | elapsed | KB | in-flight | fresh tok | error | x-request-id |
|---|---|---|---|---|---|---|---|---|---|---|
| 8 | load | 5 | 0.6 | 429 | 0.50 | 197 | 5 | - |  | 6ea477729cff7d654f059b0b2edc4dde |
| 8 | load | 6 | 0.6 | 429 | 0.51 | 197 | 6 | - |  | f244dfbd4d0992bd193059232a65c021 |
| 8 | load | 3 | 0.6 | 429 | 0.56 | 197 | 3 | - |  | bf2d12b97bc6bc9fd737f57b317b695f |
| 8 | load | 4 | 0.6 | 429 | 0.54 | 197 | 4 | - |  | 0ec1f146ba3521a84219f14b4242c5e2 |
| 8 | load | 1 | 0.6 | 429 | 0.61 | 197 | 1 | - |  | 72182b69442cf98ab987f1d41f02bb75 |
| 8 | load | 2 | 0.6 | 429 | 0.60 | 197 | 2 | - |  | 3c03d33152cf3f2ef5452b3be4e3d703 |
| 8 | load | 7 | 0.6 | 429 | 0.52 | 197 | 7 | - |  | 4f55b4413cad478afe7a6d5bf0863d20 |
| 8 | load | 8 | 0.6 | 429 | 0.51 | 197 | 8 | - |  | 84be2cc368169e12faf6f0824a706c4a |
