# Devices for Paseo

Install the Devices package on the Paseo daemon host.

```sh
paseo plugin install git:Asherlc/paseo-plugins:plugins/devices
```

For a revision on a branch, pass `--ref` with its branch name or commit. See the [overview](OVERVIEW.md) for requirements and device controls.

Open **Device → More actions → Annotate** on a booted iOS simulator. Add pins or drag boxes, write your notes, then use **Add to draft** to move the marked screenshot's file path and notes into the chat whose agent last selected that simulator with `use_device`. If no chat has claimed it, select the simulator from that chat's devices picker first. Nothing is sent automatically.

## SwiftUI previews

Add an optional `paseo-previews.json` to the workspace root to launch named states of a **separate** preview app on a booted iOS simulator. The main app target is never inferred.

```json
{
  "project": "Previews/Previews.xcodeproj",
  "scheme": "Previews",
  "bundleId": "com.example.previews",
  "previews": [
    { "id": "card/default", "title": "Card · Default" },
    { "id": "card/long-title", "title": "Card · Long title" }
  ]
}
```

`project` is relative to the workspace and must resolve inside it; `bundleId` identifies the preview app's build product. Each `id` is a short path-shaped name passed to the app as `--paseo-preview <id>`. Choose **Device → More actions → Previews** to launch a state: an incremental Debug build runs in the background and the pane shows building/opened/error, using the live screen to interact. Agents can do the same through `device-picker`'s `list_previews` and `open_preview`; wait for the `opened` status before driving the preview. A catalog-less workspace shows setup guidance instead.

Any plain SwiftUI app can read the argument — no `#Preview` macro or Storybook is required:

```swift
@main
struct PreviewsApp: App {
  var body: some Scene {
    WindowGroup { PreviewRoot(id: ProcessInfo.paseoPreview ?? "card/default") }
  }
}

extension ProcessInfo {
  static var paseoPreview: String? {
    let args = processInfo.arguments
    guard let flag = args.firstIndex(of: "--paseo-preview"), args.count > flag + 1 else { return nil }
    return args[flag + 1]
  }
}
```

Switching to a different id terminates the running app so the new launch argument takes effect.

## Development

Run the package checks from `plugins/devices`.

```sh
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

CI runs these checks on Node 22 when the Devices package or workflow changes. [Devices workflow](../../.github/workflows/devices.yml)

## Upstream and license

This package is based on Devices by Zeyad Obaia, copyright 2026. [Upstream source](https://github.com/ZedObaia/paseo-plugins/tree/bbb7ca1069e86ea83bb2a4b3148bc2710f79a37a/plugins/devices) · [MIT License](LICENSE)
