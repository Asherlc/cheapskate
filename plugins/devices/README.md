# Devices for Paseo

Install the Devices package on the Paseo daemon host.

```sh
paseo plugin install git:Asherlc/paseo-plugins:plugins/devices
```

For a revision on a branch, pass `--ref` with its branch name or commit. See the [overview](OVERVIEW.md) for requirements and device controls.

Open **Device → More actions → Annotate** on a booted iOS simulator. Add pins or drag boxes, write your notes, then use **Add to draft** to move the marked screenshot's file path and notes into an agent chat.

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
