/** Stop only a child created by this test, with bounded graceful/forced waits. */
export async function stopChild(child, graceMs = 2000) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  await new Promise((resolve, reject) => {
    let force, deadline;
    const finish = error => {
      clearTimeout(force); clearTimeout(deadline);
      child.removeListener('exit', exited); child.removeListener('error', failed);
      if (error) reject(error); else resolve();
    };
    const exited = () => finish();
    const failed = error => finish(error);
    child.once('exit', exited); child.once('error', failed);
    force = setTimeout(() => child.kill('SIGKILL'), graceMs);
    deadline = setTimeout(() => finish(new Error('Test child did not exit after forced termination')), graceMs * 2);
    child.kill('SIGTERM');
  });
}

/** Bound fixture handshakes so a regression fails instead of waiting forever. */
export async function withTimeout(promise, label, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
