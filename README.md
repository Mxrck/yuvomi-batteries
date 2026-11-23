# yuvomi-batteries

Where are my rechargeable batteries? A [Yuvomi](https://github.com/ulsklyc/yuvomi) extension
module plus a small sidecar service.

You declare a stock (`24 × AAA · Duracell · Recharge`) and the service keeps track of **places**:
each battery is in a device, in the charger, in the drawer, or **unaccounted for** ("Sin ubicar").
One rule is hard and enforced twice, in code and by SQLite triggers: the places always add up to
the stock, so nothing can be placed that you do not own.

- **Place** batteries in a device, **move** them (partially) between places, **change** a device's
  batteries in one atomic step (old ones to the charger, drawer or trash, new ones from the drawer),
  **find** unaccounted ones, and **discard** dead ones (which lowers the stock).
- Losing a battery is *not* discarding it: it goes back to "Sin ubicar", and finding it later is a
  move out of there.
- No automatic reminders: the module shows dates and ages, it does not notify.

## Layout

```
modules/batteries/   browser module served by Yuvomi at /m/batteries   (turn C)
service/app/         sidecar: db.mjs (schema, migrations, triggers), places.mjs (domain)
service/test/        node --test suites
```

## Development

Node ≥ 22.13 (no npm dependencies; `node:sqlite` works without a flag there, the production image
is `node:24-slim`).

```sh
npm test        # or: node --disable-warning=ExperimentalWarning --test service/test/*.test.mjs
```

## Tested against

- **Yuvomi 2.94.0** (`ghcr.io/ulsklyc/yuvomi:2.94.0`) — the only version this module has been
  checked against. The module contract (`/api.js`, `capabilities`, the shape of
  `GET /api/v1/auth/me`) may change in later releases.
- Target host: umbrelOS 2.0.1 at `192.168.50.211`. **Port 8184** checked free on 2026-11-23
  (`curl http://192.168.50.211:8184/` → connection refused); re-check right before installing.

## Trust notice

This module is the owner's own code. If it ends up installed by copying its folder into Yuvomi's
modules directory (the sidecar does that at start-up), Yuvomi serves it **enabled without the
admin approval step** that Settings → Modules normally requires, and it can no longer be replaced
from Settings. That trade-off is deliberate; if you install it from the repository URL in Settings
instead, the normal approval applies.

## License

MIT
