# Altium provider — example template

This directory is a placeholder for Altium Designer EDA Actions. See the
[kicad/README.md](../kicad/README.md) for the full implementation guide;
the steps are identical for any provider.

## Altium-specific notes

- Altium exposes a COM/OLE automation interface. The bridge server would
  typically use `winax` (Node.js COM bindings) or a Python `win32com` shim.
- Document identity comes from `SchServer.GetCurrentSchDocument().UniqueId`.
- Component placement uses `SchServer.SchObjectFactory()` and
  `SchDoc.AddSchObject()`.
- DRC is available through `SchServer.ValidateCompile()`.

## Checklist

Same as kicad/README.md — capabilities, manifest registration, adapter
registration, tests, rollback verification.
