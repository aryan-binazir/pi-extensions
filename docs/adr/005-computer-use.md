# ADR 005: Platform desktop transport with one session owner

Accepted for external integrations. The original direct macOS backend is superseded below.

Pi needs screenshots and bounded input actions on Linux and macOS. Installed Linux tools include grim and wtype but no ydotool or wlrctl. A macOS-only computer-use broker cannot provide the Linux path.

Use a session-owned adapter behind typed screenshot, accessibility, click, type and scroll tools. Tool execution is sequential; the broker also serializes direct callers. Failed inspection can reconnect once, but failed mutations have unknown or partial outcomes and are never automatically repeated. Cancellation destroys transports and waits for child cleanup. Application content is untrusted; no other model runs behind the tools.

On Linux, grim captures a named output, wtype receives text through stdin, and a small native Node socket client implements the Wayland registry, output and virtual-pointer requests. Bind virtual-pointer version 2 to the named output rather than guessing global monitor coordinates. This avoids additional installation and the uinput privilege boundary. Wait for compositor acknowledgement after virtual-pointer creation and after motion, before sending the button pair. The real headless-Sway test exposed a first-device capability race: sending creation, movement and click together lost the initial click while later typing and scrolling worked. Separate acknowledgement barriers fixed the observed failure without replaying a mutation. Unsupported protocol versions and accessibility queries report unavailable. The implementation deliberately excludes fd-bearing protocols; keyboard and image transport remain maintained system programs.

On macOS, Pi connects to the existing Codex Computer Use service through its bundled MCP client. The user intended that service and its permissions, not an independently implemented Swift/CoreGraphics helper. Launch the official client under the desktop app's bundled Node runtime using a small session-owned stdio relay. A differential live probe reproduced AppleEvent error -1712 with system Node and succeeded with the bundled runtime; do not substitute a generic Node executable, patch signatures, or bypass service approvals. An actual Helium window screenshot and accessibility tree were verified after explicit user approval.

The Mac API is deliberately app/window-targeted, with screenshot pixel coordinates, element indices, page scrolling, and keyboard chords. Do not disguise it as the Linux normalized display-coordinate API. Preserve official MCP schema validation and route elicitation through Pi's confirmation UI; headless requests cannot silently approve. Pi owns only its client and relay, never the shared service. No nested model or direct Swift fallback runs behind the tools.

Linux retains `DesktopSession.run` and its Wayland backend. macOS owns an independent serialized MCP session because its app-targeted semantics and approval lifecycle differ. Both transports bound output, close owned resources on cancellation, and never automatically replay mutations. The tradeoff is dependence on the installed Codex service/client/runtime contract; mocked tests do not prove compatibility with every desktop app version.

Primary references:

- [Official virtual-pointer protocol](https://github.com/swaywm/wlr-protocols/blob/master/unstable/wlr-virtual-pointer-unstable-v1.xml)
- [Hyprland's implementation](https://github.com/hyprwm/Hyprland/blob/main/src/protocols/VirtualPointer.cpp)
- [grim manual](https://github.com/emersion/grim/blob/master/grim.1.scd) and [wtype](https://github.com/atx/wtype)
- [Apple mouse events](https://developer.apple.com/documentation/coregraphics/cgevent/init(mouseeventsource:mousetype:mousecursorposition:mousebutton:)) and [screen-capture permission preflight](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess())
- [wlroots headless renderer environment](https://github.com/swaywm/wlroots/blob/master/docs/env_vars.md)

Verification on Linux used a labeled disposable Node container with headless Sway and a synthetic GTK application. The application observed the first click, exact typed text and scroll; production grim returned an 800x600 PNG. The exact installed Pi 0.85.1 bundled executable also initialized the extension and exited through its shutdown lifecycle without provider calls. That original verification did not exercise a macOS desktop. The subsequent Codex-service rework was verified against an actual Helium window as described above.
