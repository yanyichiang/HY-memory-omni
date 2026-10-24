#!/bin/sh
set -eu
cd "$(dirname "$0")"
: "${ANIMATION_EMCC:?Explicit isolated Emscripten compiler path required}"
"$ANIMATION_EMCC" -Oz bridge.c --no-entry -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web -sFILESYSTEM=0 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=67108864 '-sEXPORTED_FUNCTIONS=["_malloc","_free","_animation_create","_animation_input","_animation_encode","_animation_free"]' '-sEXPORTED_RUNTIME_METHODS=["HEAPU8","HEAPU32"]' -o animation.mjs
