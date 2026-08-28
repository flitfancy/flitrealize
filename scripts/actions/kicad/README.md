# KiCad provider — example template

This directory is a placeholder for KiCad EDA Actions. It demonstrates the
provider subdirectory layout. No Actions are implemented yet.

## How to implement

### 1. Adapter bridge

Create a bridge server that can execute Python or IPC commands inside a
running KiCad instance. The bridge must implement the control protocol
expected by `eda-host.mjs`:

```text
bridge-control.mjs ensure --json     → start/reuse bridge, return session info
bridge-control.mjs status --json     → return connection state
bridge-control.mjs execute --code-file <path> --json  → execute and return result
```

The bridge exposes an `eda` global object inside the executed code, matching
the API surface that `eda-capabilities.js` probes.

### 2. eda-capabilities.js

The first file to implement. Probe the KiCad API surface and return a
capability map:

```js
return await (async () => {
  const checks = {
    'document.current': ['kicad_sch', 'getSheet'],
    'component.list': ['kicad_sch', 'getComponents'],
    'wire.list': ['kicad_sch', 'getWires'],
    'net.list': ['kicad_sch', 'getNets'],
    // ... add more as needed
  };
  // ... same pattern as easyeda-pro/eda-capabilities.js
})();
```

### 3. Register in manifest.json

```json
{
  "providers": {
    "kicad": {
      "kind": "eda",
      "displayName": "KiCad",
      "status": "experimental"
    }
  },
  "actions": {
    "kicad-capabilities": {
      "file": "kicad/eda-capabilities.js",
      "description": "Read-only feature detection for the active KiCad document.",
      "contractVersion": 1,
      "domain": "system",
      "runtime": "eda",
      "providers": ["kicad"],
      "defaultMode": "inspect",
      "modes": { "inspect": { "mutates": false } },
      "requires": { "all": ["document.current"] }
    }
  }
}
```

### 4. Register the adapter

```bash
node scripts/eda-host.mjs register --eda kicad --adapter-root /path/to/kicad-bridge
```

### 5. Write tests

Create `tests/kicad-capabilities.test.mjs` with mock objects:

```js
import { loadAction } from './helpers/action-harness.mjs';
const execute = await loadAction('eda-capabilities', 'kicad');
const result = await execute(mockEda, { mode: 'inspect' });
// assert result.capabilities...
```

### 6. Checklist before marking `status: "tested"`

- [ ] `eda-capabilities` passes with live KiCad
- [ ] At least one mutating Action (component place or wire) passes
      inspect → plan → apply → verify → rollback cycle
- [ ] Rollback leaves the schematic in the original state
- [ ] All tests pass: `node --test tests/kicad-*.test.mjs`
