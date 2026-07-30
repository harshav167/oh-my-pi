# `webrtc-audio-processing-sys` vendor

Pinned copy of crates.io `webrtc-audio-processing-sys@2.1.0` (upstream
`tonarino/webrtc-audio-processing`, published from revision
`c14d7af1760baff83e8210fee336a0cae0faaa7d`). The published `.crate` already
carries the DSP sources under `webrtc-audio-processing/`, so no git submodule is
fetched.

## Why it is vendored

`build.rs::get_defined_symbols` hardcodes GNU `nm` long options
(`--defined-only --format=posix`). Apple's `nm` rejects both, so the crate
cannot build on macOS as published. The vendored copy selects Apple's `-U -P`
on Apple hosts and skips the archive/member header rows (`…:`) that Apple's
POSIX output interleaves with symbol rows.

That function is the only change. Re-apply it when bumping the version.

## Build requirements

Only macOS links this crate (`crates/pi-natives/Cargo.toml`, under
`cfg(target_os = "macos")`).

- **Meson** and **Ninja** — the DSP builds through Meson.
- **`llvm-tools`** (`rust-objcopy`) — prefixes the static archive's symbols.
  Declared in `rust-toolchain.toml`.
- **Network at build time** — `webrtc-audio-processing/subprojects/abseil-cpp.wrap`
  downloads abseil-cpp 20240722.0 from GitHub plus a patch from
  `wrapdb.mesonbuild.com`. Dropping both files into
  `webrtc-audio-processing/subprojects/packagecache/` under their exact
  `source_filename` / `patch_filename` names makes the build hermetic; we don't,
  because the build already requires crates.io.
