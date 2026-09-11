# Computer use

Pi reasons about screenshots and calls five tools directly. There is no nested model or Codex computer-use broker.

| Tool | Behavior |
| --- | --- |
| `computer_screenshot` | Returns a PNG plus output name, width and height. Omit `output` to select the first named Linux output or macOS main display. |
| `computer_accessibility` | Returns a bounded macOS focused-app AX tree. Linux returns `available: false`. |
| `computer_click` | Clicks normalized x/y within the named screenshot output. Coordinates range from 0 to 1. |
| `computer_type` | Types literal text into the focused application, at most 10,000 characters. |
| `computer_scroll` | Scrolls at the current pointer position; positive dx is right, positive dy is down. |

These tools act on the actual logged-in desktop. Inspect focus before typing. A successful mutation reports dispatch, not application success. A cancelled or failed mutation may have partly executed; inspect before deciding to repeat it. The extension never retries a mutation. Pi's auto-mode handles approval through ordinary `tool_call` events; these tools do not claim filesystem-read permissions or bypass that policy. Without auto-mode, Pi's normal tool execution applies.

## Linux, including Hyprland

Required programs are `grim` and `wtype`. The logged-in compositor must expose `wl_output` version 4 for named outputs and `zwlr_virtual_pointer_manager_v1` version 2 for pointer control. Hyprland implements these protocols. Screenshot capture additionally requires grim's screencopy protocol; typing requires wtype's virtual-keyboard protocol. The pointer adapter speaks the Wayland wire protocol over the existing session socket and needs no ydotool daemon, `/dev/uinput` access, wlrctl, native build or global install.

`WAYLAND_DISPLAY` identifies the socket. Relative socket names also require `XDG_RUNTIME_DIR`. These values must refer to the intended active session; stale tmux/SSH values cause explicit connection errors. The extension never searches other desktop sessions or changes environment/configuration globally. It currently supports little-endian Linux hosts.

Each click binds its virtual pointer to the exact named output used by the screenshot. `grim -s 1` uses logical scale. Output removal invalidates the connection instead of silently retargeting clicks. Scroll acts at the current pointer location; the output argument identifies the pointer device, not a new cursor location. Position it first with an intentional click if needed.

No installed Linux accessibility service is assumed. Element-tree queries explicitly report unavailable. Screenshots remain usable without a macOS broker. Missing binaries, protocols or socket permissions produce errors rather than simulated success.

## macOS

Requires Apple's Swift runtime/Command Line Tools, `/usr/sbin/screencapture`, and the hosting terminal's Screen Recording and Accessibility permissions. The bundled Swift source runs as a session-local helper; installation does not compile a binary. First use may take longer while Swift prepares it. Missing tools or denied OS permission produce explicit errors. The extension does not request permissions, open settings or alter TCC records.

This backend captures and clicks the main display only, identified as `main`. Screenshots use native capture resolution; click coordinates are normalized, so Retina scaling does not require pixel conversion. AX results omit values, limit strings to 500 characters, depth to six and nodes to 200. Application-provided titles/descriptions remain untrusted content.

The helper and its subprocesses are killed as one process group on cancellation/shutdown. Its private screenshot directory is removed by the Node owner, including after helper failure. No screenshot is added to the repository.

## Verification and limits

Tools execute sequentially, and one session broker also serializes direct callers. Inspection can reconnect once after a transport failure. Deadlines are 15 seconds on Linux and 30 seconds on macOS; cancellation closes native resources before queued work continues. Screenshot output is bounded to 16 MiB.

Tests use synthetic Unix sockets, harmless fixtures and broker calls. The disposable verification script under a disposable Sway/GTK verification harness exercises the production adapter against headless Sway and a synthetic GTK application. It never mounts the host Wayland socket. macOS CI typechecks the Swift helper without running it. CI does not prove macOS TCC grants or actual desktop interaction. No actual user-desktop smoke test is claimed.
