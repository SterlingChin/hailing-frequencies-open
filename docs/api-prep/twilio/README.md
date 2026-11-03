# Twilio preparation

Use the [root setup instructions](../../../README.md); there is no separate installation in this folder. Put your own `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` in the root `.env` before authorized API requests. Account SID is the username in this Basic-auth pairing.

| Stack | Base URL | Environment | Operations |
| --- | --- | --- | ---: |
| `twilio` | `https://api.twilio.com` | `production` | 197 |
| `messaging` | `https://messaging.twilio.com` | `default` | 58 |
| `lookups` | `https://lookups.twilio.com` | `default` | 10 |
| `verify` | `https://verify.twilio.com` | `default` | 57 |

All four environments are production. Select the stack explicitly: `/v2/Services` belongs to `verify`, not the core Twilio host.

Read [GOTCHAS](GOTCHAS.md), [BUGS](BUGS.md), and the [examples](examples/README.md). The stack files hold 27 authored notes. Historical Trial-account failures do not establish the state of your account. Check your own entitlements, phone numbers and budget before a live workflow; this import supplies none of them.
