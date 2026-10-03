import { useEffect, useRef, useState } from 'react';
import * as Blockly from 'blockly/core';
import { EDITOR_FORMAT } from '@monad-hack/strategy';
import type { DeploymentProfile, WorkspaceEnvelope } from '@monad-hack/strategy';
import { COMPILER_WARNING, localWarning } from './blocks/definitions.ts';
import { validateWorkspace } from './validation.ts';
import type { Problem, Validation } from './validation.ts';

const DEBOUNCE_MS = 250;

export function saveEnvelope(workspace: Blockly.Workspace): WorkspaceEnvelope {
  return { editorFormat: EDITOR_FORMAT, blockly: Blockly.serialization.workspaces.save(workspace) };
}

/** Puts each problem on its block under COMPILER_WARNING, skipping text the block already shows itself. */
function markBlocks(workspace: Blockly.WorkspaceSvg, problems: readonly Problem[], previous: ReadonlySet<string>): Set<string> {
  const byBlock = new Map<string, string[]>();
  for (const p of problems) if (p.blockId) byBlock.set(p.blockId, [...byBlock.get(p.blockId) ?? [], p.message]);
  for (const id of previous) if (!byBlock.has(id)) workspace.getBlockById(id)?.setWarningText(null, COMPILER_WARNING);
  for (const [id, messages] of byBlock) {
    const block = workspace.getBlockById(id);
    if (!block) continue;
    const local = localWarning(block);
    block.setWarningText(messages.filter(m => m !== local).join('\n') || null, COMPILER_WARNING);
  }
  return new Set(byBlock.keys());
}

/** Scrolls to a block and moves keyboard focus onto it. */
export function focusBlock(workspace: Blockly.WorkspaceSvg, id: string): void {
  const block = workspace.getBlockById(id);
  if (!block) return;
  workspace.centerOnBlock(id);
  Blockly.getFocusManager().focusNode(block);
}

/**
 * Revalidates the workspace after every non-UI change (debounced) and whenever the profile changes.
 * A run that finishes after a newer one started is discarded, so the panel never shows stale results.
 */
export function useLiveValidation(workspace: Blockly.WorkspaceSvg | undefined, profile: DeploymentProfile): Validation | undefined {
  const [validation, setValidation] = useState<Validation>();
  const flagged = useRef<Set<string>>(new Set());
  const { experience, mode } = profile;
  useEffect(() => {
    if (!workspace) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let run = 0; let lastText = ''; let disposed = false;
    const check = async () => {
      const envelope = saveEnvelope(workspace);
      const text = JSON.stringify(envelope);
      if (text === lastText) return; // warnings and selection never change the saved JSON
      lastText = text;
      const mine = ++run;
      const result = await validateWorkspace(envelope, { experience, mode });
      if (disposed || mine !== run) return;
      flagged.current = markBlocks(workspace, result.problems, flagged.current);
      setValidation(result);
    };
    const listener = (event: Blockly.Events.Abstract) => {
      if (event.isUiEvent) return;
      clearTimeout(timer); timer = setTimeout(() => void check(), DEBOUNCE_MS);
    };
    workspace.addChangeListener(listener);
    void check();
    return () => { disposed = true; clearTimeout(timer); workspace.removeChangeListener(listener); };
  }, [workspace, experience, mode]);
  return validation;
}
