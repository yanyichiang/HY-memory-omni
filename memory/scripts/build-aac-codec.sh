#!/bin/sh
# Explicit developer rebuild only: normal npm setup/build uses the committed artifacts.
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CODEC_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../codecs/aac" && pwd)
: "${AAC_BUILD_DIR:?Set AAC_BUILD_DIR to an isolated absolute build directory}"
: "${AAC_EMSCRIPTEN_ROOT:?Set AAC_EMSCRIPTEN_ROOT to the Emscripten 4.0.7 install/emscripten directory}"
case "$AAC_BUILD_DIR" in /*) ;; *) echo 'AAC_BUILD_DIR must be absolute' >&2; exit 1;; esac
mkdir -p "$AAC_BUILD_DIR"
export PATH="$AAC_EMSCRIPTEN_ROOT:$PATH"
emcc --version | head -1 | grep ' 4.0.7' >/dev/null || { echo 'Emscripten 4.0.7 required' >&2; exit 1; }
# EM_CONFIG and EM_CACHE may point inside AAC_BUILD_DIR; never activate an SDK globally.
tar -xJf "$CODEC_DIR/source/ffmpeg-9.0.tar.xz" -C "$AAC_BUILD_DIR"
cd "$AAC_BUILD_DIR/ffmpeg-9.0"
emconfigure ./configure --target-os=none --arch=wasm32 --enable-cross-compile \
  --cc=emcc --cxx=em++ --ar=emar --ranlib=emranlib --nm=emnm \
  --disable-x86asm --disable-inline-asm --disable-runtime-cpudetect \
  --disable-doc --disable-programs --disable-network --disable-everything \
  --disable-autodetect --disable-sdl2 --disable-pthreads --disable-avdevice \
  --disable-avformat --disable-avfilter --disable-swscale --disable-swresample \
  --disable-iconv --disable-zlib --disable-bzlib --disable-lzma \
  --enable-decoder=aac --enable-parser=aac --optflags=-Oz
make -j2 libavcodec/libavcodec.a libavutil/libavutil.a
# Independent module is replaceable. No threads, filesystem, CLI or runtime Wasm compilation.
emcc -Oz -I. "$CODEC_DIR/decoder-wrapper.c" libavcodec/libavcodec.a libavutil/libavutil.a -lm \
  --no-entry -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=67108864 -sFILESYSTEM=0 \
  '-sEXPORTED_FUNCTIONS=["_malloc","_free","_aac_create","_aac_decode","_aac_output","_aac_rate","_aac_channels","_aac_profile","_aac_free"]' \
  '-sEXPORTED_RUNTIME_METHODS=["HEAPU8","HEAPF32"]' -o "$AAC_BUILD_DIR/decoder.mjs"
cp "$AAC_BUILD_DIR/decoder.mjs" "$AAC_BUILD_DIR/aac-decoder.mjs"
cp "$AAC_BUILD_DIR/decoder.wasm" "$AAC_BUILD_DIR/aac-decoder.wasm"
printf 'Built %s/aac-decoder.mjs and .wasm; review and replace the two committed codec artifacts together.\n' "$AAC_BUILD_DIR"
