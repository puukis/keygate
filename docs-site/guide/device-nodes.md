# Device Nodes

Device nodes let Keygate broker actions to a paired machine over the existing gateway websocket.

Current runtime support is implemented for the macOS app.

## Supported macOS capabilities

- `notify`
- `location`
- `camera`
- `screen`
- `shell`

High-risk capabilities require explicit approval on the device before the action runs:

- `camera`
- `screen`
- `shell`

## Pairing flow

1. Open the macOS app settings.
2. In **Integrations → Device Node**, choose the capabilities you want to expose.
3. Click **Start Pairing**.
4. Approve the generated pairing request.
5. The app stores node credentials locally and automatically registers with the gateway on future reconnects.

The node then:

- authenticates with `node_register`
- advertises platform/version/permissions
- sends periodic `node_heartbeat` updates
- handles `node_invoke_request` asynchronously

## Runtime inspection

### Web app

Open **Instances** to inspect:

- Docker sandboxes
- paired nodes
- online/offline state
- last seen timestamps
- last invocation timestamps

### CLI

Pairing and node state live in the node store under the Keygate config root.

The main operational checks surface through:

```bash
keygate doctor
keygate status
```

## Permission model

Node records include:

- declared capabilities
- trust state
- platform/version
- online state
- permission status per capability

On macOS, permission status is derived from system APIs where possible:

- notifications
- Core Location
- camera access
- screen capture access

## Media uploads

`camera` and `screen` actions can upload their captured image back to the gateway using the normal image upload route. When the caller includes a `sessionId`, the node returns an attachment payload that downstream UIs can display or store.

## Failure modes

Common reasons a node invocation fails:

- node is offline
- requested capability is not paired
- the action was denied on-device
- a required macOS permission is missing
- the action timed out before the node replied

`keygate doctor` reports node-store health and unknown permission drift.
