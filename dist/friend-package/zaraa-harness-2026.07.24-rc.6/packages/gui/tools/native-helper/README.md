# zaraa-gui-helper

Swift CLI that sits between `@zaraa/gui` and macOS APIs (ScreenCaptureKit, CGEvent).

Build: `swift build -c release`
Output: `.build/release/ZaraaGuiHelper`

The TS package's `pnpm build:native` script copies this to `~/.zaraa/bin/zaraa-gui-helper`.

## Permissions

First run prompts for Screen Recording, Accessibility, and Input Monitoring.
