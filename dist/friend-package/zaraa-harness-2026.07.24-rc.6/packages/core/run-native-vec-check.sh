#!/bin/bash
# Temporary debug script: reproduce the flake-002 false-green scenario.
# Not part of the permanent fix — delete after use.
export ZARAA_RUN_NATIVE_VEC_TESTS=1
cd "$(dirname "$0")"
npx vitest run --config vitest.config.ts src/memory/__tests__/turbovec-backend.test.ts
