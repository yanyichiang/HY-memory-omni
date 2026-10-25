#!/bin/sh
# Offline codec rebuild/relink. All codec sources and modifications are local.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${EM_CONFIG:?Set EM_CONFIG to the Emscripten 4.0.7 configuration file}"
: "${EMSCRIPTEN_ROOT:?Set EMSCRIPTEN_ROOT to the Emscripten 4.0.7 directory containing em++}"
export EM_CONFIG
export PATH="$EMSCRIPTEN_ROOT:$PATH"
WORK=${HEIF_BUILD_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/hy-heif-build.XXXXXX")}
mkdir -p "$WORK"
if [ -n "$(ls -A "$WORK")" ]; then
  echo 'HEIF_BUILD_DIR must be empty; choose a separate build directory.' >&2
  exit 1
fi
mkdir -p "$WORK/sources" "$WORK/build" "$WORK/install"
for name in libaom-3.15.1 libde265-1.0.18 libheif-1.23.6; do
  tar -xzf "$ROOT/sources/$name.tar.gz" -C "$WORK/sources"
done
for patch_file in "$ROOT"/patches/*.patch; do
  patch -d "$WORK/sources/libheif-1.23.6" -p1 < "$patch_file"
done
em++ --version
emcmake cmake -S "$WORK/sources/libaom-3.15.1" -B "$WORK/build/aom" -G Ninja \
 -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$WORK/install" -DCMAKE_C_FLAGS=-O2 -DCMAKE_CXX_FLAGS=-O2 \
 -DAOM_TARGET_CPU=generic -DCONFIG_AV1_ENCODER=0 -DCONFIG_AV1_DECODER=1 -DCONFIG_MULTITHREAD=0 \
 -DCONFIG_RUNTIME_CPU_DETECT=0 -DENABLE_DOCS=0 -DENABLE_EXAMPLES=0 -DENABLE_TESTS=0 -DENABLE_TESTDATA=0 \
 -DENABLE_TOOLS=0 -DENABLE_NASM=0 -DBUILD_SHARED_LIBS=OFF
cmake --build "$WORK/build/aom" -j2
cmake --install "$WORK/build/aom"
emcmake cmake -S "$WORK/sources/libde265-1.0.18" -B "$WORK/build/de265" -G Ninja \
 -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$WORK/install" -DBUILD_SHARED_LIBS=OFF \
 -DENABLE_DECODER=OFF -DENABLE_ENCODER=OFF -DENABLE_SDL=OFF -DENABLE_SHERLOCK265=OFF \
 -DENABLE_INTERNAL_DEVELOPMENT_TOOLS=OFF -DWITH_FUZZERS=OFF -DSUPPORTS_SSE2=OFF -DSUPPORTS_SSSE3=OFF -DSUPPORTS_SSE4_1=OFF
cmake --build "$WORK/build/de265" -j2
cmake --install "$WORK/build/de265"
emcmake cmake -S "$WORK/sources/libheif-1.23.6" -B "$WORK/build/heif" -G Ninja \
 -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$WORK/install" -DCMAKE_PREFIX_PATH="$WORK/install" -DCMAKE_CXX_FLAGS=-D__EMSCRIPTEN_STANDALONE_WASM__=1 \
 -DAOM_INCLUDE_DIR="$WORK/install/include" -DAOM_LIBRARY="$WORK/install/lib/libaom.a" \
 -DLIBDE265_INCLUDE_DIR="$WORK/install/include" -DLIBDE265_LIBRARY="$WORK/install/lib/libde265.a" \
 -DBUILD_SHARED_LIBS=OFF -DENABLE_PLUGIN_LOADING=OFF -DENABLE_MULTITHREADING_SUPPORT=OFF -DENABLE_PARALLEL_TILE_DECODING=OFF \
 -DWITH_LIBDE265=ON -DWITH_AOM_DECODER=ON -DWITH_AOM_ENCODER=OFF -DWITH_X265=OFF -DWITH_X264=OFF \
 -DWITH_KVAZAAR=OFF -DWITH_UVG266=OFF -DWITH_VVDEC=OFF -DWITH_VVENC=OFF -DWITH_OpenH264_DECODER=OFF \
 -DWITH_DAV1D=OFF -DWITH_SvtEnc=OFF -DWITH_RAV1E=OFF -DWITH_JPEG_DECODER=OFF -DWITH_JPEG_ENCODER=OFF \
 -DWITH_OpenJPEG_ENCODER=OFF -DWITH_OpenJPEG_DECODER=OFF -DWITH_FFMPEG_DECODER=OFF -DWITH_OPENJPH_ENCODER=OFF \
 -DWITH_UNCOMPRESSED_CODEC=OFF -DWITH_WEBCODECS=OFF -DWITH_LIBSHARPYUV=OFF -DWITH_EXAMPLES=OFF \
 -DWITH_GDK_PIXBUF=OFF -DBUILD_TESTING=OFF -DWITH_HEADER_COMPRESSION=OFF
cmake --build "$WORK/build/heif" -j2
cmake --install "$WORK/build/heif"
em++ "$ROOT/bridge.cpp" -I"$WORK/install/include" -L"$WORK/install/lib" -lheif -lde265 -laom \
 -O2 --emit-symbol-map --no-entry -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 \
 -sWASM_ASYNC_COMPILATION=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=16777216 -sMAXIMUM_MEMORY=67108864 \
 -sABORTING_MALLOC=0 -sWASM_BIGINT=1 -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32 \
 -sEXPORTED_FUNCTIONS=_malloc,_free,_img_open,_img_next,_img_close,_img_kind,_img_count,_img_item_id,_img_item_width,_img_item_height,_img_primary,_img_select,_img_track_count,_img_track_id,_img_track_type,_img_width,_img_height,_img_plane,_img_stride,_img_timescale,_img_duration,_img_repetitions,_img_depth,_img_icc_size,_img_nclx_transfer,_img_nclx_primaries,_img_error \
 -o "$ROOT/image-decoder.mjs"
