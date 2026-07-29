import { useState } from 'react';
import { ConfirmModal } from '@/components/ConfirmModal';

// Ports askConfirm/confirmModalRespond (rack-audit-app.html's STATE.confirmModal
// pattern) as a per-screen hook: `ask(message, onConfirm)` opens the modal,
// `element` renders it. Drop-in replacement for a native Alert.alert
// confirm, themed to match the rest of the app instead of the OS dialog.
export function useConfirmDialog() {
  const [state, setState] = useState<{ message: string; onConfirm: () => void } | null>(null);

  const ask = (message: string, onConfirm: () => void) => setState({ message, onConfirm });

  const respond = (ok: boolean) => {
    const current = state;
    setState(null);
    if (ok && current) current.onConfirm();
  };

  const element = (
    <ConfirmModal visible={!!state} message={state?.message ?? ''} onCancel={() => respond(false)} onConfirm={() => respond(true)} />
  );

  return { ask, element };
}
