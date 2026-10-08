function normalizeNativeWirePoints(value) {
  if(!Array.isArray(value)||!value.length)throw new Error('Invalid native wire coordinates');
  if(value.every(p=>p&&typeof p==='object'&&!Array.isArray(p)&&Number.isFinite(p.x)&&Number.isFinite(p.y)))return value.map(p=>({x:p.x,y:p.y}));
  if(value.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)))return value.map(([x,y])=>({x,y}));
  const segments=[];
  const add=line=>{
    if(!Array.isArray(line)||line.some(n=>!Number.isFinite(n))||line.length<4||line.length%2)throw new Error('Invalid native wire coordinates');
    if(line.length%4===0){for(let i=0;i<line.length;i+=4)segments.push([{x:line[i],y:line[i+1]},{x:line[i+2],y:line[i+3]}]);}
    else for(let i=0;i+3<line.length;i+=2)segments.push([{x:line[i],y:line[i+1]},{x:line[i+2],y:line[i+3]}]);
  };
  if(value.every(Number.isFinite))add(value);else for(const line of value)add(line);
  if(segments.length===1)return segments[0];
  const key=p=>Math.round(p.x*1e6)+','+Math.round(p.y*1e6),vertices=new Map(),adjacency=new Map();
  for(const [i,edge]of segments.entries())for(let side=0;side<2;side++){
    const p=edge[side],k=key(p);if(!vertices.has(k))vertices.set(k,p);if(!adjacency.has(k))adjacency.set(k,[]);adjacency.get(k).push({index:i,other:key(edge[1-side])});
  }
  const ends=[...vertices.keys()].filter(k=>adjacency.get(k).length===1);
  if(ends.length!==2||[...adjacency.values()].some(a=>a.length>2))throw new Error('Only a connected wire chain is supported');
  ends.sort((a,b)=>vertices.get(a).x-vertices.get(b).x||vertices.get(a).y-vertices.get(b).y);
  const used=new Set(),points=[];let current=ends[0];
  for(;;){points.push(vertices.get(current));const edge=adjacency.get(current).find(e=>!used.has(e.index));if(!edge)break;used.add(edge.index);current=edge.other;}
  if(used.size!==segments.length)throw new Error('Disconnected native wire chain');
  return points;
}

return await (async () => {
  const request = typeof flitrealizeInput === 'undefined' ? { mode: 'inspect' } : flitrealizeInput;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function callGetter(object, name, fallback = null) {
    try {
      return typeof object?.[name] === 'function' ? object[name]() : fallback;
    } catch {
      return fallback;
    }
  }

  function finiteOrNull(value) {
    if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function textOrNull(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function hashText(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
  }

  function sourceFingerprint(source) {
    return hashText(source.split(/\r?\n/).filter(line => line && !line.includes('"type":"DOCHEAD"')).join('\n'));
  }

  async function optionalCall(namespace, method, ...args) {
    if (typeof eda?.[namespace]?.[method] !== 'function') return { value: null, error: null, unsupported: true };
    try {
      return { value: await eda[namespace][method](...args), error: null, unsupported: false };
    } catch (error) {
      return { value: null, error: error.message, unsupported: false };
    }
  }

  async function readNativeNetlist(document, sourceBefore) {
    const result = {
      source: 'sch_ManufactureData.getNetlistFile',
      format: { requested: 'JLCEDA', interpretation: 'unverified' },
      scope: { activeDocumentUuid: String(document.uuid), projectUuid: String(document.parentProjectUuid ?? 'unknown-project'), pageRange: 'unverified', endpointMembership: 'unverified', sourceUnchanged: null },
    };
    if (typeof eda?.sch_ManufactureData?.getNetlistFile !== 'function') return { ...result, status: 'unavailable', reason: 'API_UNAVAILABLE' };
    if (typeof sourceBefore?.value !== 'string' || !sourceBefore.value.trim()) return { ...result, status: sourceBefore?.error ? 'error' : 'unavailable', reason: 'SOURCE_GUARD_UNAVAILABLE', error: sourceBefore?.error ?? null };
    const beforeDocument = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    if (beforeDocument.value?.uuid !== document.uuid || beforeDocument.value?.parentProjectUuid !== document.parentProjectUuid || beforeDocument.value?.documentType !== 1) fail('DOCUMENT_MISMATCH', 'Schematic changed before native netlist inspection.');

    let captured;
    try {
      // Official ESYS_NetlistType.JLCEDA_PRO is 'JLCEDA'. Keep the File in this
      // action and return only its text; do not save or transport binary data.
      const file = await eda.sch_ManufactureData.getNetlistFile(undefined, 'JLCEDA');
      if (file === undefined) captured = { status: 'unavailable', reason: 'FILE_UNAVAILABLE' };
      else if (!file || typeof file.text !== 'function') captured = { status: 'unsupported', reason: 'FILE_TEXT_UNSUPPORTED' };
      else {
        const metadata = { name: typeof file.name === 'string' ? file.name : null, type: typeof file.type === 'string' ? file.type : null, size: Number.isFinite(file.size) && file.size >= 0 ? file.size : null };
        try {
          const raw = await file.text();
          captured = typeof raw !== 'string' || !raw.trim()
            ? { status: 'unsupported', reason: 'EMPTY_OR_NON_TEXT_NETLIST', file: metadata }
            : { status: 'ok', raw, file: metadata, rawFingerprint: hashText(raw) };
        } catch (error) { captured = { status: 'error', reason: 'FILE_TEXT_FAILED', error: String(error?.message ?? error), file: metadata }; }
      }
    } catch (error) { captured = { status: 'error', reason: 'NETLIST_API_FAILED', error: String(error?.message ?? error) }; }

    const afterDocument = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    if (afterDocument.value?.uuid !== document.uuid || afterDocument.value?.parentProjectUuid !== document.parentProjectUuid || afterDocument.value?.documentType !== 1) fail('DOCUMENT_MISMATCH', 'Schematic changed during native netlist inspection.');
    const sourceAfter = await optionalCall('sys_FileManager', 'getDocumentSource');
    if (typeof sourceAfter.value !== 'string' || !sourceAfter.value.trim()) return { ...result, status: 'error', reason: 'SOURCE_GUARD_UNVERIFIED', error: sourceAfter.error ?? 'Source could not be reread after netlist inspection.' };
    const before = sourceFingerprint(sourceBefore.value), after = sourceFingerprint(sourceAfter.value);
    if (before !== after) fail('DOCUMENT_CHANGED_DURING_INSPECTION', 'Schematic source changed while reading the native netlist.');
    return { ...result, ...captured, scope: { ...result.scope, sourceBeforeFingerprint: before, sourceAfterFingerprint: after, sourceUnchanged: true } };
  }

  function normalizePoints(value) { return normalizeNativeWirePoints(value); }

  function componentBinding(component) {
    const state = callGetter(component, 'getState_Component', {}) || {};
    const libraryUuid = textOrNull(callGetter(component, 'getState_LibraryUuid'))
      ?? textOrNull(state.libraryUuid)
      ?? textOrNull(state.library_uuid);
    const deviceUuid = textOrNull(callGetter(component, 'getState_Uuid'))
      ?? textOrNull(state.uuid)
      ?? textOrNull(state.deviceUuid);
    return { libraryUuid, deviceUuid };
  }

  async function summarizePin(pin, componentId) {
    const number = textOrNull(callGetter(pin, 'getState_PinNumber'))
      ?? textOrNull(callGetter(pin, 'getState_Number'))
      ?? textOrNull(callGetter(pin, 'getState_Name'));
    const nativeId = textOrNull(callGetter(pin, 'getState_PrimitiveId'))
      ?? textOrNull(callGetter(pin, 'getState_Id'))
      ?? (number ? `${componentId}:${number}` : null);
    if (!number || !nativeId) return null;
    const x = finiteOrNull(callGetter(pin, 'getState_X'));
    const y = finiteOrNull(callGetter(pin, 'getState_Y'));
    const summarized = {
      number,
      name: textOrNull(callGetter(pin, 'getState_PinName')) ?? textOrNull(callGetter(pin, 'getState_Name')) ?? '',
      nativeId,
      net: null,
      noConnect: Boolean(callGetter(pin, 'getState_NoConnected', callGetter(pin, 'getState_NoConnect', false))),
      extensions: {
        easyedaPro: {
          rotation: finiteOrNull(callGetter(pin, 'getState_Rotation')),
          pinType: callGetter(pin, 'getState_PinType'),
          pinShape: callGetter(pin, 'getState_PinShape'),
        },
      },
    };
    if (x !== null && y !== null) summarized.position = { x, y };
    return summarized;
  }

  async function summarizeComponent(component, sheetId) {
    const nativeId = textOrNull(callGetter(component, 'getState_PrimitiveId'));
    const designator = textOrNull(callGetter(component, 'getState_Designator'));
    if (!nativeId || !designator) return null;

    const pinsProbe = await optionalCall('sch_PrimitiveComponent', 'getAllPinsByPrimitiveId', nativeId);
    const pinValues = Array.isArray(pinsProbe.value) ? pinsProbe.value : [];
    const pins = (await Promise.all(pinValues.map((pin) => summarizePin(pin, nativeId)))).filter(Boolean);
    const binding = componentBinding(component);
    const x = finiteOrNull(callGetter(component, 'getState_X'));
    const y = finiteOrNull(callGetter(component, 'getState_Y'));
    const otherProperty = callGetter(component, 'getState_OtherProperty', {}) || {};
    const summarized = {
      designator,
      nativeId,
      sheetId,
      name: textOrNull(callGetter(component, 'getState_Name')) ?? '',
      value: textOrNull(callGetter(component, 'getState_Value')) ?? textOrNull(otherProperty.Value) ?? '',
      manufacturer: textOrNull(callGetter(component, 'getState_Manufacturer')) ?? '',
      mpn: textOrNull(callGetter(component, 'getState_ManufacturerPart')) ?? '',
      footprint: textOrNull(callGetter(component, 'getState_Footprint')),
      includeInBom: Boolean(callGetter(component, 'getState_AddIntoBom', true)),
      includeInPcb: Boolean(callGetter(component, 'getState_AddIntoPcb', true)),
      rotation: finiteOrNull(callGetter(component, 'getState_Rotation')) ?? 0,
      mirror: Boolean(callGetter(component, 'getState_Mirror', false)),
      pins,
      bindings: {
        easyedaPro: {
          libraryUuid: binding.libraryUuid,
          deviceUuid: binding.deviceUuid,
        },
      },
      extensions: {
        easyedaPro: {
          componentType: callGetter(component, 'getState_ComponentType'),
          pinInspection: pinsProbe.error ? 'error' : pinsProbe.unsupported ? 'unsupported'
            : !Array.isArray(pinsProbe.value) || pins.length !== pinValues.length ? 'incomplete' : 'ok',
          pinInspectionError: pinsProbe.error,
        },
      },
    };
    if (x !== null && y !== null) summarized.position = { x, y };
    return summarized;
  }

  function summarizeWire(wire) {
    const line = callGetter(wire, 'getState_Line', null);
    const fallback = line === null ? callGetter(wire, 'getState_Points', []) : line;
    return {
      primitiveId: textOrNull(callGetter(wire, 'getState_PrimitiveId')),
      net: textOrNull(callGetter(wire, 'getState_Net')) ?? '',
      lineWidth: finiteOrNull(callGetter(wire, 'getState_LineWidth')),
      lineType: callGetter(wire, 'getState_LineType'),
      points: normalizePoints(fallback),
    };
  }

  function interpretNativeNetlist(evidence, components, nets, document) {
    const diagnostics = [], assignments = [], byNet = new Map(nets.map(net => [net.name, net]));
    const audit = { status: 'unverified', counts: { exportedComponents: 0, pageComponents: components.length, matchedComponents: 0, matchedPins: 0, emptyNetPins: 0 }, outsidePageRefs: [], unmatchedExportPins: [], diagnostics };
    const add = (severity, code, message, detail = {}) => diagnostics.push({ severity, code, message, extensions: { easyedaPro: detail } });
    evidence.audit = audit;
    if (evidence.status !== 'ok') return;
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    let parsed;
    try { parsed = JSON.parse(evidence.raw); }
    catch { add('warning', 'NATIVE_NETLIST_FORMAT_UNVERIFIED', 'Native text is not the verified JLCEDA JSON format.'); return; }
    if (!object(parsed) || parsed.version !== '2.0.0' || !object(parsed.components) || typeof parsed.projectId !== 'string') {
      add('warning', 'NATIVE_NETLIST_FORMAT_UNVERIFIED', 'Only the observed JLCEDA 2.0.0 component/pinInfoMap structure is interpreted.'); return;
    }
    evidence.format = { ...evidence.format, version: parsed.version, interpretation: 'current-page-pin-projection' };
    evidence.scope = { ...evidence.scope, pageRange: 'current-page-projection;export-range-unverified', endpointMembership: 'current-page-matched-pins' };
    if (parsed.projectId !== String(document.parentProjectUuid)) {
      add('error', 'NATIVE_NETLIST_PROJECT_MISMATCH', 'Exported netlist belongs to a different project.', { expected: document.parentProjectUuid, actual: parsed.projectId });
      audit.status = 'mismatch'; return;
    }
    const page = new Map(), duplicatePageRefs = new Set(), exported = new Map(), duplicateExportRefs = new Set();
    for (const component of components) {
      if (page.has(component.designator)) duplicatePageRefs.add(component.designator);
      page.set(component.designator, component);
    }
    for (const ref of duplicatePageRefs) add('error', 'DUPLICATE_PAGE_DESIGNATOR', 'Current-page designators are ambiguous.', { ref });
    let inventoryComplete = true;
    for (const [key, value] of Object.entries(parsed.components)) {
      if (!object(value) || !object(value.props) || !textOrNull(value.props.Designator) || !object(value.pinInfoMap)) {
        inventoryComplete = false; add('warning', 'NATIVE_COMPONENT_FORMAT_UNVERIFIED', 'An exported component does not have the verified identity/pin structure.', { nativeKey: key }); continue;
      }
      const ref = value.props.Designator;
      if (exported.has(ref)) duplicateExportRefs.add(ref);
      exported.set(ref, value); audit.counts.exportedComponents++;
      if (!page.has(ref)) audit.outsidePageRefs.push(ref);
    }
    audit.outsidePageRefs = [...new Set(audit.outsidePageRefs)].sort();
    for (const ref of duplicateExportRefs) add(page.has(ref) ? 'error' : 'warning', 'DUPLICATE_EXPORTED_DESIGNATOR', 'Exported designators are ambiguous; these entries were not used.', { ref });
    for (const [ref, component] of page) {
      if (duplicatePageRefs.has(ref) || duplicateExportRefs.has(ref)) continue;
      const value = exported.get(ref);
      if (!value) {
        if (inventoryComplete) add(component.includeInPcb ? 'error' : 'warning', 'PAGE_COMPONENT_MISSING_FROM_NETLIST', 'Current-page component has no exported entry.', { ref, includeInPcb: component.includeInPcb });
        continue;
      }
      if (component.extensions.easyedaPro.pinInspection !== 'ok') {
        add('warning', 'CURRENT_PAGE_PINS_UNVERIFIED', 'The symbol pin read was incomplete; exported numbers were not treated as observed symbol pins.', { ref }); continue;
      }
      const pagePins = new Map(), duplicatePagePins = new Set(), exportPins = new Map(), duplicateExportPins = new Set();
      for (const pin of component.pins) {
        if (pagePins.has(pin.number)) duplicatePagePins.add(pin.number);
        pagePins.set(pin.number, pin);
      }
      for (const pin of duplicatePagePins) add('error', 'DUPLICATE_PAGE_PIN', 'Current-page pin numbers are ambiguous.', { ref, pin });
      let pinInventoryComplete = true;
      for (const [key, pin] of Object.entries(value.pinInfoMap)) {
        if (!object(pin) || typeof pin.number !== 'string' || !pin.number || !object(pin.props) || typeof pin.props['Pin Number'] !== 'string' || typeof pin.net !== 'string') {
          pinInventoryComplete = false; add('warning', 'NATIVE_PIN_FORMAT_UNVERIFIED', 'A native pin lacks an explicit number, Pin Number or net.', { ref, nativeKey: key }); continue;
        }
        if (exportPins.has(pin.number)) duplicateExportPins.add(pin.number);
        exportPins.set(pin.number, { ...pin, key });
      }
      for (const pin of duplicateExportPins) add('error', 'DUPLICATE_EXPORTED_PIN', 'Exported pin numbers are ambiguous; these entries were not used.', { ref, pin });
      for (const [number, nativePin] of exportPins) {
        if (duplicateExportPins.has(number) || duplicatePagePins.has(number)) continue;
        if (nativePin.key !== number || nativePin.props['Pin Number'] !== number) {
          add('error', 'NATIVE_PIN_NUMBER_CONFLICT', 'Native pin key, number and Pin Number disagree; no logical/physical remapping was guessed.', { ref, pin: number }); continue;
        }
        const pin = pagePins.get(number);
        if (!pin) {
          audit.unmatchedExportPins.push({ ref, pin: number, net: nativePin.net });
          add(nativePin.net ? 'error' : 'warning', 'EXPORTED_PIN_NOT_ON_CURRENT_PAGE_COMPONENT', 'Exported pin does not match a read-back symbol pin; its purpose was not inferred.', { ref, pin: number, net: nativePin.net }); continue;
        }
        if (pin.noConnect && nativePin.net !== '') { add('error', 'NATIVE_NETLIST_NC_CONFLICT', 'An explicitly no-connect symbol pin has an assigned native net.', { ref, pin: number, net: nativePin.net }); continue; }
        if (pin.net !== null && pin.net !== nativePin.net) { add('error', 'NATIVE_NETLIST_PIN_NET_CONFLICT', 'Native net differs from the current pin net.', { ref, pin: number, expected: pin.net, actual: nativePin.net }); continue; }
        assignments.push({ component, pin, nativePin });
      }
      if (pinInventoryComplete) for (const number of pagePins.keys()) if (!exportPins.has(number)) add('error', 'PAGE_PIN_MISSING_FROM_NETLIST', 'A read-back symbol pin is missing from the native netlist.', { ref, pin: number });
      audit.counts.matchedComponents++;
    }
    // Only unambiguous current-page observations enter the existing snapshot.
    // Empty assignment is preserved without fabricating a no-connect marker.
    for (const { component, pin, nativePin } of assignments) {
      pin.net = nativePin.net;
      pin.extensions.easyedaPro.netSource = { api: evidence.source, formatVersion: parsed.version, scope: 'current-page-pin-number-match' };
      audit.counts.matchedPins++;
      if (nativePin.net === '') { audit.counts.emptyNetPins++; continue; }
      if (!byNet.has(nativePin.net)) {
        const net = { name: nativePin.net, nativeId: null, endpoints: [] }; byNet.set(nativePin.net, net); nets.push(net);
      }
      byNet.get(nativePin.net).endpoints.push({ component: component.designator, pin: pin.number, nativePinId: pin.nativeId });
    }
    for (const net of nets) {
      net.endpoints.sort((a, b) => a.component.localeCompare(b.component) || a.pin.localeCompare(b.pin));
      net.extensions = { easyedaPro: { endpointSource: evidence.source, endpointScope: 'current-page-matched-components' } };
    }
    nets.sort((a, b) => a.name.localeCompare(b.name));
    const incomplete = audit.counts.matchedPins !== components.reduce((sum, component) => sum + component.pins.length, 0)
      || !inventoryComplete || components.some(c => c.extensions.easyedaPro.pinInspection !== 'ok');
    audit.status = diagnostics.some(d => d.severity === 'error') ? 'mismatch'
      : incomplete || diagnostics.some(d => d.severity === 'warning') || audit.outsidePageRefs.length ? 'partial' : 'matched';
  }

  function connectionEvidence(source, componentValues, wires) {
    const attributes = new Map();
    let parsed = 0;
    for (const line of source.split(/\r?\n/).filter(Boolean)) {
      const split = line.indexOf('||');
      if (split < 0) fail('SOURCE_FORMAT_UNSUPPORTED', 'Connection audit needs native schematic source records.');
      let head, payload;
      try {
        head = JSON.parse(line.slice(0, split));
        payload = JSON.parse(line.slice(split + 2).replace(/\|$/, ''));
      } catch { fail('SOURCE_FORMAT_UNSUPPORTED', 'Cannot parse schematic source for label audit.'); }
      parsed += 1;
      if (head.type !== 'ATTR') continue;
      const entries = attributes.get(payload.parentId) || [];
      entries.push(payload);
      attributes.set(payload.parentId, entries);
    }
    if (!parsed) fail('SOURCE_UNAVAILABLE', 'Empty source cannot prove label visibility.');
    const visibility = (id, key) => {
      const attrs = (attributes.get(id) || []).filter(attr => attr.key === key);
      return { count: attrs.length, visible: attrs.length ? attrs.some(attr => attr.valueVisible !== false) : null };
    };
    const markers = componentValues.filter(component => ['netflag', 'netport'].includes(callGetter(component, 'getState_ComponentType')))
      .map(component => {
        const primitiveId = callGetter(component, 'getState_PrimitiveId');
        const name = visibility(primitiveId, 'Name');
        return { primitiveId, componentType: callGetter(component, 'getState_ComponentType'),
          net: callGetter(component, 'getState_Net', ''), x: finiteOrNull(callGetter(component, 'getState_X')),
          y: finiteOrNull(callGetter(component, 'getState_Y')), rotation: finiteOrNull(callGetter(component, 'getState_Rotation')),
          mirror: Boolean(callGetter(component, 'getState_Mirror', false)), nameVisible: name.visible, nameAttrCount: name.count };
      });
    for (const wire of wires) {
      const net = visibility(wire.primitiveId, 'NET');
      wire.netVisible = net.visible;
      wire.netAttrCount = net.count;
    }
    return { markers, sourceEvidence: 'ok', sourceFingerprint: sourceFingerprint(source) };
  }

  async function captureState() {
    const documentProbe = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    const nativeDocument = documentProbe.value;
    if (!nativeDocument?.uuid) fail('DOCUMENT_UNAVAILABLE', 'No active EasyEDA Pro document is available.');
    if (nativeDocument.documentType !== 1) fail('WRONG_DOCUMENT_TYPE', 'The active EasyEDA Pro document is not a schematic.');
    if ((request.expectedDocumentUuid && request.expectedDocumentUuid !== nativeDocument.uuid)
      || (request.expectedProjectUuid && request.expectedProjectUuid !== nativeDocument.parentProjectUuid)) fail('DOCUMENT_MISMATCH', 'Unexpected schematic/project.');

    const documentUuid = String(nativeDocument.uuid);
    const projectUuid = String(nativeDocument.parentProjectUuid ?? 'unknown-project');
    const nativeNetlistAvailable = typeof eda?.sch_ManufactureData?.getNetlistFile === 'function';
    const sourceBefore = nativeNetlistAvailable ? await optionalCall('sys_FileManager', 'getDocumentSource') : null;
    const componentsProbe = await optionalCall('sch_PrimitiveComponent', 'getAll');
    const componentValues = Array.isArray(componentsProbe.value) ? componentsProbe.value : [];
    const physicalValues = componentValues.filter(component => !['netflag', 'netport', 'sheet'].includes(callGetter(component, 'getState_ComponentType')));
    const ignoredNetMarkerCount = componentValues.filter(c => ['netflag','netport'].includes(callGetter(c,'getState_ComponentType'))).length;
    const componentSummaries = await Promise.all(physicalValues.map((component) => summarizeComponent(component, documentUuid)));
    const components = componentSummaries.filter(Boolean);
    const omittedComponents = componentSummaries.length - components.length;

    const wiresProbe = await optionalCall('sch_PrimitiveWire', 'getAll');
    const wires = Array.isArray(wiresProbe.value) ? wiresProbe.value.map(summarizeWire) : [];
    let extraEvidence = {}, backupSource;
    if (request.includeConnectionEvidence || request.includeSource) {
      if (!Array.isArray(componentsProbe.value) || !Array.isArray(wiresProbe.value)) fail('STATE_READ_FAILED', 'Connection audit needs complete component and wire reads.');
      if (request.includeConnectionEvidence && componentValues.some(component =>
        !['netflag', 'netport', 'sheet'].includes(callGetter(component, 'getState_ComponentType'))
        && (!textOrNull(callGetter(component, 'getState_PrimitiveId')) || !textOrNull(callGetter(component, 'getState_Designator'))))) {
        fail('COMPONENT_IDENTITY_INCOMPLETE', 'A physical component has no primitive ID or designator; it cannot be omitted from connection audit.');
      }
      const probe = typeof sourceBefore?.value === 'string' ? sourceBefore : await optionalCall('sys_FileManager', 'getDocumentSource');
      if (typeof probe.value !== 'string' || !probe.value.trim()) fail('SOURCE_UNAVAILABLE', 'Connection audit needs the schematic source.');
      if (request.includeConnectionEvidence) extraEvidence = connectionEvidence(probe.value, componentValues, wires);
      if (request.includeSource) backupSource = probe.value;
    }
    const nets = [];
    const nativeNetlist = await readNativeNetlist(nativeDocument, sourceBefore);
    interpretNativeNetlist(nativeNetlist, components, nets, nativeDocument);
    // The native export is the primary network read. The legacy names API is
    // only a display fallback when export interpretation is unavailable.
    let netsProbe, netReadSource;
    if (nativeNetlist.audit.status !== 'unverified') {
      netReadSource = nativeNetlist.source;
      netsProbe = { value: nets.map(net => net.name), error: null, unsupported: false };
    } else {
      netReadSource = 'sch_Net.getAllNetsName';
      netsProbe = await optionalCall('sch_Net', 'getAllNetsName');
      const fallbackNames = Array.isArray(netsProbe.value) ? [...new Set(netsProbe.value.map(textOrNull).filter(Boolean))].sort() : [];
      nets.push(...fallbackNames.map(name => ({ name, nativeId: null, endpoints: [] })));
    }

    const queried = ['document'];
    const unsupported = [];
    const unknown = [];
    for (const [name, probe] of [['components', componentsProbe], ['wires', wiresProbe], ['nets', netsProbe]]) {
      if (probe.unsupported) unsupported.push(name);
      else queried.push(name);
      if (probe.error) unknown.push(name);
    }
    if (!nativeNetlistAvailable || nativeNetlist.status === 'unsupported') unsupported.push('native-netlist');
    else if (nativeNetlist.status === 'ok') queried.push('native-netlist');
    else unknown.push('native-netlist');
    if (nativeNetlist.status === 'ok' && nativeNetlist.audit.status === 'unverified') unknown.push('native-netlist-endpoint-semantics');
    if (nativeNetlist.status === 'ok') unknown.push('native-netlist-export-range');
    if (nativeNetlist.audit.status !== 'matched') unknown.push('net-endpoints');
    if (omittedComponents) unknown.push('components-without-designators');
    if (components.some((component) => component.extensions.easyedaPro.pinInspection !== 'ok')) unknown.push('component-pins');

    const diagnostics = [];
    diagnostics.push(...nativeNetlist.audit.diagnostics);
    if (nativeNetlist.status !== 'ok') diagnostics.push({ severity: 'warning', code: 'NATIVE_NETLIST_NOT_AVAILABLE', message: `Native netlist was not covered: ${nativeNetlist.reason}.` });
    else diagnostics.push({ severity: 'info', code: 'NATIVE_NETLIST_CURRENT_PAGE_SCOPE', message: 'Only verified current-page component/pin matches supply endpoints; whole-export page coverage is not asserted.' });
    if (omittedComponents) diagnostics.push({
      severity: 'warning',
      code: 'COMPONENT_IDENTITY_INCOMPLETE',
      message: `${omittedComponents} primitive(s) were omitted because a native id or designator was unavailable.`,
    });
    if (unknown.includes('component-pins')) diagnostics.push({
      severity: 'warning',
      code: 'PIN_INSPECTION_INCOMPLETE',
      message: 'At least one component could not provide a complete pin list.',
    });
    if (nativeNetlist.audit.status !== 'matched' && nets.length) diagnostics.push({
      severity: 'info',
      code: 'NET_ENDPOINTS_UNKNOWN',
      message: 'Current-page endpoint coverage is incomplete; no membership was inferred from wire geometry.',
    });

    const componentGeometry = components.map((component) => ({
      designator: component.designator,
      nativeId: component.nativeId,
      position: component.position ?? null,
      rotation: component.rotation,
      mirror: component.mirror,
      pins: component.pins.map((pin) => ({ number: pin.number, nativeId: pin.nativeId, position: pin.position ?? null, noConnect: pin.noConnect })),
    })).sort((a, b) => a.designator.localeCompare(b.designator));
    const wireGeometry = wires.map((wire) => ({
      primitiveId: wire.primitiveId,
      net: wire.net,
      lineWidth: wire.lineWidth,
      lineType: wire.lineType,
      points: wire.points,
    })).sort((a, b) => String(a.primitiveId).localeCompare(String(b.primitiveId)));
    const capabilitiesFingerprint = hashText(stableStringify({ queried, unsupported, unknown }));
    const componentsFingerprint = hashText(stableStringify(componentGeometry));
    const connectivityFingerprint = hashText(stableStringify({ nets, wires: wireGeometry }));
    const documentFingerprint = hashText(stableStringify({
      documentUuid,
      projectUuid,
      componentsFingerprint,
      connectivityFingerprint,
      ...(request.includeConnectionEvidence ? { sourceFingerprint: extraEvidence.sourceFingerprint } : {}),
    }));
    const finalDocument = await optionalCall('dmt_SelectControl', 'getCurrentDocumentInfo');
    if (finalDocument.value?.uuid !== nativeDocument.uuid || finalDocument.value?.parentProjectUuid !== nativeDocument.parentProjectUuid
      || finalDocument.value?.documentType !== 1) fail('DOCUMENT_MISMATCH', 'Schematic changed during inspection.');

    const snapshot = {
      kind: 'flitrealize.schematic-snapshot',
      schemaVersion: 1,
      provider: 'easyeda-pro',
      capturedAt: new Date().toISOString(),
      project: { id: projectUuid, nativeId: projectUuid },
      document: {
        id: documentUuid,
        nativeId: documentUuid,
        type: 'schematic',
        extensions: { easyedaPro: { tabId: nativeDocument.tabId ?? null, documentType: nativeDocument.documentType } },
      },
      sheets: [{ id: documentUuid, nativeId: documentUuid, name: textOrNull(nativeDocument.title) ?? 'Active schematic' }],
      components,
      nets,
      diagnostics,
      coverage: { queried, unsupported, unknown },
      fingerprints: {
        document: documentFingerprint,
        connectivity: connectivityFingerprint,
        components: componentsFingerprint,
        capabilities: capabilitiesFingerprint,
      },
      extensions: { easyedaPro: { wires, ...extraEvidence, nativeNetlist, netReadSource, ignoredNetMarkerCount } },
    };

    return {
      ...(backupSource === undefined ? {} : { backupSource }),
      snapshot,
      state: {
        document: {
          uuid: documentUuid,
          tabId: nativeDocument.tabId ?? null,
          documentType: nativeDocument.documentType,
          parentProjectUuid: nativeDocument.parentProjectUuid ?? null,
        },
        inspectionFingerprint: documentFingerprint,
        coverage: {
          document: 'ok',
          components: componentsProbe.error ? 'error' : componentsProbe.unsupported ? 'unsupported' : 'ok',
          wires: wiresProbe.error ? 'error' : wiresProbe.unsupported ? 'unsupported' : 'ok',
          nets: netsProbe.error ? 'error' : netsProbe.unsupported ? 'unsupported' : 'ok',
          nativeNetlist: nativeNetlist.status,
          nativeNetlistEndpoints: nativeNetlist.audit.status,
        },
        componentCount: components.length,
        componentPrimitiveCount: componentValues.length,
        ignoredNetMarkerCount,
        wireCount: wires.length,
        netCount: nets.length,
        components,
        wires,
        nets: nets.map(net => net.name),
      },
    };
  }

  const mode = request.mode ?? 'inspect';
  if (mode !== 'inspect') fail('INVALID_MODE', `Unsupported mode: ${mode}`);
  const captured = await captureState();
  const issues = captured.snapshot.diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  return {
    schemaVersion: 2,
    status: issues.length ? 'verification-failed' : captured.snapshot.coverage.unknown.length || captured.snapshot.coverage.unsupported.length ? 'inspected-with-gaps' : 'inspected',
    readOnly: true,
    ...(issues.length ? { issues } : {}),
    ...(captured.backupSource === undefined ? {} : { backupSource: captured.backupSource }),
    snapshot: captured.snapshot,
    state: captured.state,
  };
})();
