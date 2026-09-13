# Node realtime harness report

- Node: v24.14.0 · platform: win32 x64
- Addon: extensions-kernel-napi (C ABI wrapper, release build) · abi 1
- Cadence: 500 fps (frame budget 2.00 ms) · tick data plane (ext_tick byte path)

## S1 · 500 fps × 1 plugin

- tick calls: 1478 (failures: 0) · frames: 1478 · overruns(>budget): 1
- tick latency: p50 2.40 µs · p90 6.80 µs · p99 15.70 µs · p999 19.70 µs · max 13143.30 µs
- whole-frame JS time: p50 2.80 µs · p99 19.60 µs · max 13151.30 µs

## S2 · 500 fps × 20 plugins

- tick calls: 30000 (failures: 0) · frames: 1500 · overruns(>budget): 0
- tick latency: p50 0.90 µs · p90 1.60 µs · p99 4.30 µs · p999 14.30 µs · max 60.60 µs
- whole-frame JS time: p50 22.50 µs · p99 72.50 µs · max 140.00 µs

## S3 · async coexistence (100 ms boundary plugin)

- tick calls: 1500 (failures: 0) · frames: 1500 · overruns(>budget): 0
- tick latency: p50 2.50 µs · p90 7.50 µs · p99 16.20 µs · p999 20.10 µs · max 35.40 µs
- whole-frame JS time: p50 2.90 µs · p99 20.10 µs · max 37.70 µs
- healthy P99: baseline 22.90 µs → under async-slow pressure 16.20 µs (**offset -29.26%**) → recovery 16.40 µs
- slow kernel.invoke: 8/8 accepted as async markers (worst accept 0.202 ms)
- async envelopes delivered via sink: 8/8
