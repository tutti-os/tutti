# Getting Started Onboarding

This package owns the Tutti built-in Getting Started onboarding app, with
packaged media assets compressed for distribution.

## Development

```bash
pnpm --filter @tutti-os/builtin-tutti-onboarding dev
```

Then open:

```txt
http://127.0.0.1:3003
```

## Package

```bash
pnpm generate:builtin-apps
```

The generated package includes optimized static assets, the Tutti manifest, and
a local runtime server.
