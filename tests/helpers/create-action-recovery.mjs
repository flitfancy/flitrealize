import assert from 'node:assert/strict';

// Reuse each action's ordinary mock and plan builder; never connect to an editor.
export async function checkCreateRecovery({ action, createEda, namespace, createMethod = 'create', seed, applyRequest }) {
  for (const fault of ['existing-id', 'duplicate-id', 'switch-document', 'switch-project', 'write-then-throw', 'no-id', 'lost-readback', 'switch-during-readback', 'known-create-bad-readback']) {
    const eda = createEda();
    const api = eda[namespace];
    const existing = fault === 'existing-id' ? await seed(eda) : null;
    const input = await applyRequest(eda);
    const originalCreate = api[createMethod];
    const originalDelete = api.delete;
    const originalDocument = await eda.dmt_SelectControl.getCurrentDocumentInfo();
    let first = null, deleteCalls = 0, createCalls = 0;
    if (fault === 'switch-during-readback' || fault === 'known-create-bad-readback') {
      const readMethod = typeof api.get === 'function' ? 'get' : 'getAll';
      const originalRead = api[readMethod];
      let intercepted = false;
      api[readMethod] = async (...args) => {
        const value = await originalRead(...args);
        if (!first || intercepted) return value;
        intercepted = true;
        if (fault === 'switch-during-readback') {
          eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ ...originalDocument, uuid: 'another-document' });
          return value;
        }
        const changed = item => item && ({ ...item, getState_Net: () => 'WRONG', getState_Layer: () => -1 });
        return Array.isArray(value) ? value.map(changed) : changed(value);
      };
    }
    api.delete = async (...args) => { deleteCalls++; return originalDelete(...args); };
    api[createMethod] = async (...args) => {
      createCalls++;
      if (fault === 'existing-id') return existing;
      if (fault === 'duplicate-id' && first) return first;
      const created = await originalCreate(...args);
      first ??= created;
      if (fault === 'switch-document') {
        eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ ...originalDocument, uuid: 'another-document' });
      }
      if (fault === 'switch-project') eda.dmt_SelectControl.getCurrentDocumentInfo = async () => ({ ...originalDocument, parentProjectUuid: 'another-project' });
      if (fault === 'write-then-throw') throw new Error('Reply lost after create');
      if (fault === 'no-id') return {};
      if (fault === 'lost-readback') {
        api.getAll = async () => { throw new Error('Readback unavailable'); };
        api.get = async () => { throw new Error('Readback unavailable'); };
      }
      return created;
    };
    const result = await action(eda, input);
    assert.notEqual(result.status, 'applied', `${namespace}/${fault}: must not report applied`);
    if (fault === 'known-create-bad-readback') {
      assert.equal(result.status, 'rolled-back', `${namespace}: confirmed creations can still be rolled back`);
      assert.equal(deleteCalls, 1);
      assert.equal((await api.getAll()).length, 0);
    } else {
      assert.notEqual(result.status, 'rolled-back', `${namespace}/${fault}: restoration is not established`);
      if (fault !== 'lost-readback') assert.equal(deleteCalls, 0, `${namespace}/${fault}: uncertain ownership must not delete`);
    }
    if (fault === 'switch-document') assert.equal(createCalls, 1, `${namespace}: stop before the next create`);
    if (existing) assert.ok((await api.getAll()).some(item => item.getState_PrimitiveId() === existing.getState_PrimitiveId()), 'preexisting object preserved');
  }
}
