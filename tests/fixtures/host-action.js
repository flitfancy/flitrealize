return {
  status: 'inspected',
  readOnly: true,
  fingerprint: 'fixture-fingerprint',
  selected: flitrealizeInput.selected,
  unsupported: flitrealizeInput.unsupported,
  context: {
    action: flitrealizeContext.action,
    projectRoot: flitrealizeContext.projectRoot,
    skillVersion: flitrealizeContext.skillVersion,
  },
};
