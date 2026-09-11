# ADR 005: Direct desktop transport with one session owner

Accepted for external integrations.

Pi needs screenshots and bounded input actions on Linux and macOS. Installed Linux tools include grim and wtype but no ydotool or wlrctl. A macOS-only computer-use broker cannot provide the Linux path.

Use a session-owned adapter behind typed screenshot, accessibility, click, type and scroll tools. Tool execution is sequential; the broker also serializes direct callers. Failed inspection can reconnect once, but failed mutations have unknown or partial outcomes and are never automatically repeated. Cancellation destroys transports and waits for child cleanup. Application content is untrusted; no other model runs behind the tools.

On Linux, grim captures a named output, wtype receives text through stdin, and a small native Node socket client implements the Wayland registry, output and virtual-pointer requests. Bind virtual-pointer version 2 to the named output rather than guessing global monitor coordinates. This avoids additional installation and the uinput privilege boundary. Wait for compositor acknowledgement after virtual-pointer creation and after motion, before sending the button pair. The real headless-Sway test exposed a first-device capability race: sending creation, movement and click together lost the initial click while later typing and scrolling worked. Separate acknowledgement barriers fixed the observed failure without replaying a mutation. Unsupported protocol versions and accessibility queries report unavailable. The implementation deliberately excludes fd-bearing protocols; keyboard and image transport remain maintained system programs.

On macOS, a reusable Swift JSON-lines helper uses CoreGraphics and AX APIs. It requires Command Line Tools and preexisting OS permission. The Node owner manages the process group and temporary screenshot directory. Mac CI typechecks this helper; it does not prove desktop permission or a live Mac smoke test.

This module hides wire frames, child lifetimes, output limits and platform differences behind `DesktopSession.run`. New platforms can implement that boundary without changing Pi tools. Tradeoffs are a maintained small Wayland client, explicit Linux AX absence and main-display-only macOS support.

Primary references:

- [Official virtual-pointer protocol](https://github.com/swaywm/wlr-protocols/blob/master/unstable/wlr-virtual-pointer-unstable-v1.xml)
- [Hyprland's implementation](https://github.com/hyprwm/Hyprland/blob/main/src/protocols/VirtualPointer.cpp)
- [grim manual](https://github.com/emersion/grim/blob/master/grim.1.scd) and [wtype](https://github.com/atx/wtype)
- [Apple mouse events](https://developer.apple.com/documentation/coregraphics/cgevent/init(mouseeventsource:mousetype:mousecursorposition:mousebutton:)) and [screen-capture permission preflight](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess())
- [wlroots headless renderer environment](https://github.com/swaywm/wlroots/blob/master/docs/env_vars.md)

Verification on Linux used a labeled disposable Node container with headless Sway and a synthetic GTK application. The application observed the first click, exact typed text and scroll; production grim returned an 800x600 PNG. The exact installed Pi 0.85.1 bundled executable also initialized the extension and exited through its shutdown lifecycle without provider calls. No actual macOS desktop or user desktop was exercised.
