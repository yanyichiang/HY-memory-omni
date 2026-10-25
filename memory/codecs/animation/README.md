# Bounded animation provider derivative

`encoder.mjs` consumes RGBA frames sequentially and creates an all-intra H264 MP4 with the original non-uniform timeline. It never keeps all decoded frames. `mapping` records source indices/times, actual output times, mux precision, zero-duration frames, white alpha matte and odd-dimension edge padding. This is a lossy provider representation, not a replacement for the original animation.

The codec is [minih264](https://github.com/lieff/minih264) at commit `b0baea7a80ef9d12da97301dd1099b8791b5ba43`, CC0; the pinned `minih264e.h` and `LICENSE` are included. `bridge.c` is the project bridge. The included WASM/glue were built with Emscripten 4.0.7. Retain the Emscripten and runtime notices in `../heif/licenses/` with generated output.

Limits: coded canvas 1,048,576 pixels, each side 2048, 128 frames and 8 MiB encoded output. RGBA is composited over white and converted to BT.601 limited YUV420. Zero-duration frames are not assigned synthetic holds; an entirely zero-duration sequence is rejected. All frames are intra-coded, and the mux output is checked against source timing at the chosen timebase.

Rebuild with an explicit isolated Emscripten installation: `ANIMATION_EMCC=/absolute/path/to/emcc EM_CONFIG=/absolute/path/to/config ./build.sh`. No source download or global SDK installation is performed by this script. The supplied header, bridge and build script are the complete codec build inputs.
