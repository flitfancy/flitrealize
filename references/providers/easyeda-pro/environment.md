# EasyEDA Pro environment and Bridge

Read this workflow only when establishing, diagnosing, or reusing the local
EasyEDA execution channel. It produces a bounded channel claim; it does not
authorize an EDA write.

## Inputs

- expected Provider: `easyeda-pro`;
- Adapter installation root, stored only in the host profile;
- expected project/document identity when known; and
- capabilities required by the next Action.

## Register once, ensure per live session

Keep the Bridge server and machine-specific Adapter outside the portable Skill.
Register its installation once, then let the helper start or reuse it:

```text
node scripts/eda-host.mjs register --eda easyeda-pro --adapter-root <adapter-root>
node scripts/eda-host.mjs ensure --eda easyeda-pro --require-eda
```

Host profiles may contain machine paths; project state and the public Skill must
not. A project may declare its expected EDA and document in
`.flitrealize/project.json`. A declared/connected mismatch is a hard identity
failure before any live operation.

The registered Provider catalog is the allowlist. Do not silently route another
EDA product or an unregistered Adapter through `easyeda-pro`.

## Reuse only a bounded handshake

Run the lightweight handshake before the first live EDA access in an agent
session, not every chat turn. Reuse it only while all of these remain unchanged:

- Bridge session ID;
- Adapter and EDA identity/version;
- selected window;
- intended project/document; and
- required capability fingerprint.

Re-probe after disconnect, EDA restart, window/document change, Adapter/API
version change, capability failure, or project mismatch. A cached successful
handshake says nothing about a newly selected document.

## Recover once, then stop

If the Bridge starts after the EasyEDA gateway has exhausted its retry cycle,
the helper reports `EDA_NOT_CONNECTED`. Use **API Gateway -> reconnect** once.
Starting the Bridge before opening EasyEDA normally avoids this recovery. If one
reconnect does not establish the declared EDA and document, stop and report the
observed state.

Use the helper rather than direct unauthenticated HTTP calls. The Adapter keeps
its per-session token out of prompts and returns compact structured status. Raw
code execution is transport, not authorization or proof.

## Output a layered channel claim

Do not collapse the result into a generic `connected: true`. Report separately:

- host process reachable;
- Agent authenticated to the local Adapter;
- Adapter identity/version accepted;
- EasyEDA gateway connected;
- active project/document confirmed; and
- required API capabilities present.

Agent authentication and EDA-gateway pairing are different claims. If the
gateway cannot present a pairing credential, classify it as localhost-only
local development, confirm the real document with a read-only probe, and never
use it as a shared-host or hostile-host security boundary.

The next workflow may proceed only when its required layers of this claim pass.
