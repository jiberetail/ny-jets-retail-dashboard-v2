# NY Jets Retail Dashboard V2

Client-facing analytics for the NY Jets game-day services kiosk. The dashboard
covers attributed merchandise revenue, incremental contribution, ROI, commerce
conversion, fulfillment services, product demand, and guest experience.

This project is separate from the existing NY Jets dashboard suite.

The Stadium Orders view receives cross-device order changes through the shared
Upstash Realtime feed and keeps a low-frequency API refresh as a recovery path.
Its local cache and mutation queue preserve staff work through brief network
interruptions.

## Public Dashboard

[Open Jibe Kiosk Intelligence for the NY Jets](https://jiberetail.github.io/ny-jets-retail-dashboard-v2/)

## Development

```bash
pnpm install
pnpm run dev
pnpm run build
```
