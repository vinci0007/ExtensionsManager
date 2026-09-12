# Node realtime harness report

- Node: v24.14.0 · platform: win32 x64
- Addon: extensions-kernel-napi (C ABI wrapper, release build) · abi 1
- Cadence: 500 fps (frame budget 2.00 ms) · tick data plane (ext_tick byte path)

## S1 · 500 fps × 1 plugin

- tick calls: 1475 (failures: 0) · frames: 1475 · overruns(>budget): 1
- tick latency: p50 4.70 µs · p90 13.40 µs · p99 19.50 µs · p999 26.30 µs · max 8541.70 µs
- whole-frame JS time: p50 5.40 µs · p99 24.60 µs · max 8564.00 µs

## S2 · 500 fps × 20 plugins

- tick calls: 29900 (failures: 0) · frames: 1495 · overruns(>budget): 1
- tick latency: p50 1.30 µs · p90 2.90 µs · p99 12.50 µs · p999 30.40 µs · max 2149.70 µs
- whole-frame JS time: p50 34.60 µs · p99 147.90 µs · max 2328.70 µs

## S3 · async coexistence (100 ms boundary plugin)

- tick calls: 1500 (failures: 0) · frames: 1500 · overruns(>budget): 0
- tick latency: p50 3.80 µs · p90 11.10 µs · p99 19.00 µs · p999 27.40 µs · max 169.80 µs
- whole-frame JS time: p50 4.40 µs · p99 23.40 µs · max 173.20 µs
- healthy P99: baseline 18.90 µs → under async-slow pressure 19.00 µs (**offset 0.53%**) → recovery 19.20 µs
- slow kernel.invoke: 8/8 accepted as async markers (worst accept 0.201 ms)
- async envelopes delivered via sink: 8/8
