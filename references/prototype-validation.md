# Prototype bring-up and evidence-driven revision

Read this reference for first power, subsystem testing, screening, and revision
decisions.

## Prepare proportionally

Before power, record expected rails/current, startup states, test order, limits,
and stop conditions. Use the instruments justified by the risk: current-limited
supply and meter at minimum, with oscilloscope/logic analyzer and automated logs
when they distinguish likely failures.

When feasible, build more than one prototype and preserve an unmodified board.
For staged assembly, add expensive, fragile, or high-energy loads only after
their prerequisites pass. Record fitted parts, rework, measurements, and board
identity so results remain attributable.

## Power safely

1. Inspect polarity/orientation, bridges, debris, openings, and connectors.
2. Measure unpowered resistance from each rail to ground.
3. Apply power with a conservative current limit.
4. Verify protected input and regulator rails before enabling loads.
5. Enable subsystems incrementally and record current change.
6. Test the real load while observing rail droop, ripple, startup, and temperature.

Derive limits from the actual design rather than another board's values.

## Test the functions that define success

Exercise applicable buses, IDs/status, reset, interrupts, GPIO, loads, recovery,
and power cycles. Log raw values, errors, rail state, firmware version, board
serial, and timestamps. Include credible faults without exceeding ratings.

Choose stability duration and repetition from the acceptance goal and failure
timescale. A short personal prototype test may be enough for an early gate;
24–72 hour logging is appropriate only when long-run stability is material to the
claim being made.

## Screen sensors without inventing calibration

Keep these distinct:

- vendor factory calibration;
- post-assembly screening for damage, contamination, offset, noise, and response;
- system compensation for stable enclosure/board effects;
- traceable calibration against standards with known uncertainty.

As relevant, compare offset, noise, drift, repeatability, response/recovery,
hysteresis, power cycles, temperature, and multiple boards. A stable fixed offset
may be compensated; excessive noise, drift, hysteresis, or slow response requires
investigation. Use controlled safe stimuli rather than breath, sprays, sunlight,
or ambient conditions as absolute references.

## Revise from reproducible evidence

For each material failure record board revision/serial, setup, reproduction,
measurements or waveforms, suspected domain, proposed change, and expected
measurable effect.

- **P1:** evidence-supported correction with high value;
- **P2:** improvement whose need depends on more testing;
- **P3:** complex feature requiring a clear use or fault model.

Do not create a hardware revision solely for visual routing preference,
theoretical completeness, unreproducible behavior, or speculative features.
