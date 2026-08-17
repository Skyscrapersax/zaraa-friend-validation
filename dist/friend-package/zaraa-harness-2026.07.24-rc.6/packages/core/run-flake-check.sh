#!/bin/sh
export FLAKE_SUITE=1
cd "$(dirname "$0")"
npx vitest run src/memory/__tests__/turbovec-backend.test.ts
