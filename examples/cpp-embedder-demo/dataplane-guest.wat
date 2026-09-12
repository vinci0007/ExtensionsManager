(module
  ;; Data-plane echo guest for the C++ embedder demo.
  ;; Input: host writes request bytes at offset 0, calls ext_call(0, len).
  ;; Output: guest returns (out_ptr << 32) | out_len packed in an i64.
  (memory (export "memory") 1)
  (data (i32.const 4096) "{\"echo\":true,\"guest\":\"cpp-dataplane\"}")
  (data (i32.const 8192) "{\"tick\":true}")
  (func (export "ext_call") (param $in_ptr i32) (param $in_len i32) (result i64)
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.const 4096)) (i64.const 32))
      (i64.extend_i32_u (i32.const 37))))
  (func (export "ext_tick") (param $in_ptr i32) (param $in_len i32) (result i64)
    (i64.or
      (i64.shl (i64.extend_i32_u (i32.const 8192)) (i64.const 32))
      (i64.extend_i32_u (i32.const 13)))))
