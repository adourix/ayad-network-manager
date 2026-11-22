# Electron TLS Certificate Pinning

The desktop app no longer accepts any certificate error merely because the server hostname matches `VITE_API_BASE_URL`.

## Behavior

- Normal platform certificate validation remains enabled.
- A self-signed API certificate may be accepted only when the request is HTTPS to the configured API hostname, the certificate is currently within its validity window, the error is exactly the certificate-authority error, and the certificate fingerprint matches `AYAD_API_CERT_FINGERPRINT`.
- Expired, hostname-mismatched, revoked/other TLS errors are not bypassed.
- Without a fingerprint pin, the app rejects certificate errors. Install the gateway certificate/CA in the OS trust store where possible.

## Configuration

Set `AYAD_API_CERT_FINGERPRINT` in the desktop launch environment to the exact normalized fingerprint exposed by Electron's certificate object (remove separators and use lowercase hex). The API URL must be HTTPS and the hostname must match `VITE_API_BASE_URL`.

Do not pin an arbitrary fingerprint copied from an untrusted network session. Obtain the fingerprint over a trusted local/physical channel or verify the gateway certificate directly on the server.

## Why

Accepting every certificate error for a hostname allows an attacker with a forged certificate to impersonate the gateway. Hostname matching alone is not certificate authentication. Electron documents the `certificate-error` event and certificate fingerprint fields; trust decisions should be explicit and scoped.

## Compatibility note

Self-signed deployments without a configured pin will no longer silently connect from the desktop application. This is an intentional security change. The web app remains subject to the browser/OS certificate trust rules.

