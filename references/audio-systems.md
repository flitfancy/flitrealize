# Digital audio hardware systems

Read this reference only for microphones, speakers, codecs/amplifiers, digital
audio clocks, acoustic echo cancellation, or networked audio devices.

## Contents

1. Freeze the end-to-end path
2. Treat clocks and channels as interfaces
3. Treat acoustics as board constraints
4. Separate power/noise domains
5. Prove the risky loop before freezing the PCB

## Freeze the end-to-end path

Define the owner of capture, preprocessing, wake/VAD, AEC, transport, ASR/TTS,
playback, mute, recovery, and diagnostics. Record what runs on the device, host,
or network service and how each boundary is tested. Avoid two uncoordinated AEC,
gain-control, or resampling stages in the normal path.

For playback interruption or AEC, define the reference signal source and timing
explicitly. A speaker output alone is not a usable digital reference. Record
buffering, cancellation/mute behavior, and how dropped or late frames are
observed.

## Treat clocks and channels as interfaces

For every PDM/I2S/TDM/PCM boundary record:

- master and clock source;
- clock frequency, sample rate, bit depth, slot width, and channel order;
- edge/polarity and left/right selection;
- DMA/buffer ownership and startup order;
- expected test waveform or capture method.

Confirm controller pin capabilities, boot/strap restrictions, and simultaneous
peripheral use before freezing a GPIO map. When pin mapping changes for routing,
update the machine-readable contract, schematic generator, firmware map, capture
expectations, and tests together before rerunning generated apply scripts.

## Treat acoustics as board constraints

- Verify microphone port position, recommended land pattern, seal path, and a
  keepout free of unrelated copper, vias, adhesive, and obstructing components.
- Express microphone spacing and orientation as project requirements, not a
  generic fixed distance.
- Keep loudspeaker current paths, switching nodes, vibration, and airflow from
  coupling into microphone ports and clocks. Check the final enclosure and
  speaker mounting, not only bare-board distance.
- Keep RF antenna keepouts and microphone acoustic keepouts distinct; both can
  make visually empty board area functional rather than wasted.
- Place amplifier bypass/output networks by their datasheet current loops and
  keep speaker pairs short and away from microphone data/clock paths.

## Separate power/noise domains

Budget average, peak, startup, and fault current for processor, radio, amplifier,
and microphone rails. Verify amplifier load steps, regulator stability, local
decoupling, shared return impedance, maintenance-power limits, and the default
state of high-current loads. Do not assume a connector type guarantees source
current capability.

## Prove the risky loop before freezing the PCB

When the combined capture/playback/transport/processing path is unfamiliar or
consequential, use modules or a development board to establish a measurable
closed loop. Define project-specific acceptance for runtime, frame loss,
latency, resets, audible artifacts, wake/VAD behavior, and resource headroom.

A personal custom-board prototype may proceed without this proof only as a
`CONDITIONAL` gate with the missing evidence, consequence, and arrival/bring-up
test recorded. Do not call the schematic gate fully passed merely because each
individual IC application circuit looks correct.
