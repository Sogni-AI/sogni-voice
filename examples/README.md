# Environment Examples

## Local Only (Default / Safe)

```dotenv
HOST=127.0.0.1
CORS_ORIGINS=local
```

This keeps the API bound to loopback and only allows browser origins from local development hosts such as `localhost`.

The same origin policy applies to `WS /v1/realtime/transcription`. When authentication is enabled, the bundled browser demo sends the stored API key in its first WebSocket `start` message; non-browser clients can use the normal API-key headers during the upgrade.

## Public Browser Access From Anywhere

```dotenv
HOST=0.0.0.0
AUTH_ENABLED=1
AUTH_API_KEY=replace_me
CORS_ORIGINS=*
```

Use this only when you intentionally want browser clients from any origin to call the API.

## Public Browser Access With An Allowlist

```dotenv
HOST=0.0.0.0
AUTH_ENABLED=1
AUTH_API_KEY=replace_me
CORS_ORIGINS=https://app.example.com,https://admin.example.com
```

Use this when you want public access but only from specific browser origins.

## Disable CORS Entirely

```dotenv
CORS_ORIGINS=off
```

This is useful for non-browser clients or when another proxy is handling CORS upstream.
