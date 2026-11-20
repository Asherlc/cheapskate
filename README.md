# Paseo plug-ins

A collection of [Paseo](https://paseo.sh) plug-ins. Each package is independent, with its own manifest, version, docs, and release. Install only the ones you want.

## Packages

### Cheapskate

One selectable Paseo model backed by an ordered fallback chain. When a backend hits a quota or rate limit, Cheapskate continues in the same chat with the next model.

- Source: [`plugins/cheapskate/`](plugins/cheapskate/)
- Docs: [README](plugins/cheapskate/README.md) · [overview](plugins/cheapskate/OVERVIEW.md)
- Install (registry): `paseo plugin install asherlc/cheapskate`
- Install (Git): `paseo plugin install git:Asherlc/paseo-plugins:plugins/cheapskate`

### Devices — planned

Simulator annotations for Paseo, at `plugins/devices/`. Not released yet.

## Development

Packages are installed and tested independently. For Cheapskate:

```sh
cd plugins/cheapskate
npm ci
npm run typecheck
npm test
```

Releases are automated per package from [`.github/workflows/release.yml`](.github/workflows/release.yml); a change under one package does not bump another.
