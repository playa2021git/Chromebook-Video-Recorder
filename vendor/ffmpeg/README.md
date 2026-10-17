# FFmpeg.wasm

Unmodified ESM files from npm packages:

- `@ffmpeg/ffmpeg` **0.12.15** — MIT; LICENSE.wrapper.
- `@ffmpeg/core` **0.12.10** — GPL-2.0-or-later; distributed here under GPLv3 (COPYING.GPL-3).

The single-threaded core is used, not core-mt. It does not require cross-origin
isolation or SharedArrayBuffer. All runtime files are served by this site.

## Corresponding source and build instructions

Upstream source snapshot with matching package versions and build system:
https://github.com/ffmpegwasm/ffmpeg.wasm/tree/f876f907c7e9b9bf51d4ed0b913a855a63ae63fc

Complete downloadable repository source:
https://github.com/ffmpegwasm/ffmpeg.wasm/archive/f876f907c7e9b9bf51d4ed0b913a855a63ae63fc.tar.gz

The wrapper TypeScript is in packages/ffmpeg. The C bindings, build scripts,
Dockerfile and Makefile are also included in source/ beside this notice.
The Dockerfile identifies the FFmpeg and codec library source repositories and
versions and retrieves them for the build. It uses FFmpeg n5.1.4 and Emscripten
3.1.40. See the upstream build instructions and all library stages in Dockerfile.
FFmpeg source: https://github.com/ffmpegwasm/FFmpeg/tree/n5.1.4
x264 source: https://github.com/ffmpegwasm/x264/tree/4-cores

No modifications were made to the vendored JavaScript or WebAssembly binaries.
The original project is https://github.com/ffmpegwasm/ffmpeg.wasm .
