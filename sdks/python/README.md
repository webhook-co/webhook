# webhook.co Python SDK

The official Python SDK for the [webhook.co](https://webhook.co) API. A typed client with the hardening
you'd otherwise hand-roll: bearer auth, bounded retries with jitter, cursor pagination, idempotency, and
secret redaction — with pydantic v2 models generated from the same OpenAPI contract the API is built on.

Python 3.10+. Built on `httpx`.

## Install

```sh
pip install webhook-co
```

## Quickstart

```python
import os
from webhook_co import WebhookClient

client = WebhookClient(api_key=os.environ["WEBHOOK_API_KEY"])

# Create an endpoint. The ingest URL is a credential, but not one-time — it can be re-read any time
# (POST /v1/endpoints/{id}/reveal-ingest-url, `wbhk endpoints reveal <id>`, or the dashboard).
endpoint = client.endpoints.create(name="orders-prod")
print(endpoint.ingest_url)

# List events for that endpoint (auto-paginates).
for event in client.events.list(endpoint.id):
    print(event.id, event.provider, event.verification_state)
```

The API key is a `whk_`-prefixed token from your dashboard. Keep it server-side — this SDK never prints
it, but it's still a credential.

Responses come back as validated pydantic models, so attributes are typed and snake_cased
(`endpoint.org_id`, `endpoint.created_at`).

## Pagination

List methods return a `Paginator` you can iterate directly — it follows the cursor for you:

```python
for endpoint in client.endpoints.list(name="prod"):
    print(endpoint.id)

# Collect everything (careful with large result sets):
failed = client.deliveries.list(status=["failed"]).collect()

# One page at a time (e.g. to build your own UI):
page = client.endpoints.list_page(limit=50)
print(page.items, page.next_cursor)
```

## Errors

Every failure is a `WebhookError` subclass, so you can narrow with `except` — no string matching:

```python
from webhook_co import (
    WebhookRateLimitError,
    WebhookNotFoundError,
    WebhookAuthenticationError,
)

try:
    client.endpoints.get(endpoint_id)
except WebhookNotFoundError:
    ...  # 404 — no such endpoint
except WebhookRateLimitError as err:
    print(f"retry after {err.retry_after_s}s")
except WebhookAuthenticationError:
    ...  # 401 — the key is invalid, expired, or revoked
```

Each error carries `code` (a stable capability-error string), `status` (the HTTP status), and
`request_id` when the server sent one.

## Retries & idempotency

The client retries idempotent requests on transient failures (429/502/503/504 and network errors) with
capped exponential backoff and jitter, honouring `Retry-After`. It **never** blind-retries a
non-idempotent write — creating an endpoint, rotating a secret, or an un-keyed replay won't be sent twice
by the SDK. Replays carry an idempotency key (auto-generated if you don't pass one), so those are safe:

```python
import uuid

client.events.replay(
    event.id,
    target={"kind": "destination", "destinationId": destination_id},
    idempotency_key=str(uuid.uuid4()),
)
```

Tune the budget per client:

```python
client = WebhookClient(api_key, max_retries=4, timeout_s=15)  # defaults: 2 retries, 30s
```

## Payloads

`events.get_payload` decodes the wire envelope and hands you the exact bytes (length-checked, so a
truncated body raises rather than silently short-reading):

```python
payload = client.events.get_payload(event.id)
print(payload.content_type, len(payload.body))  # payload.body is bytes
```

## Configuration

| Argument       | Default                  | Notes                                                        |
| -------------- | ------------------------ | ------------------------------------------------------------ |
| `api_key`      | —                        | Required. A `whk_` API key.                                  |
| `base_url`     | `https://api.webhook.co` | Must be https (loopback http allowed for self-host / dev).   |
| `http_client`  | a new `httpx.Client`     | Pass your own for custom transports/proxies.                 |
| `max_retries`  | `2`                      | Retries after the first attempt, idempotent requests only.   |
| `timeout_s`    | `30`                     | Per-request timeout (seconds), per httpx connect/read/write phase. |
| `refresh_auth` | —                        | Hook returning a rotated bearer on a 401 (OAuth flows).      |
| `on_debug`     | —                        | Redacted, single-line diagnostics — never the raw key.       |

Use it as a context manager to close the underlying connection pool:

```python
with WebhookClient(api_key) as client:
    client.whoami()
```

## API surface

`endpoints` (list · list_page · get · create · delete · rotate · `provider_secrets` add/list/revoke) ·
`events` (list · list_page · get · get_payload · tail · replay) · `deliveries` (list · list_page · get) ·
`replay_destinations` (create · list · delete · enable · set_ordered · rotate_signing_secret ·
list_signing_secrets) · `subscriptions` (create · list · delete) · `audit.verify` · `whoami`.

## License

Apache-2.0
