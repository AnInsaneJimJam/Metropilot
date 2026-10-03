import { useCallback, useEffect, useRef, useState } from 'react';
import * as Blockly from 'blockly/core';
import * as En from 'blockly/msg/en';
import type { Experience } from '@monad-hack/strategy';
import { ensureRoot, injectOptions, setUpBlockly } from './blocks/index.ts';
import { loadPreset, PRESETS } from './presets/index.ts';
import type { Preset } from './presets/index.ts';
import { RehearsePanel } from './rehearse/RehearsePanel.tsx';
import { StrategyPanel } from './StrategyPanel.tsx';
import { focusBlock, useLiveValidation } from './useLiveValidation.ts';

Blockly.setLocale(En as unknown as Record<string, string>);
setUpBlockly();

export function EditorPage() {
  const canvas = useRef<HTMLDivElement>(null);
  const [workspace, setWorkspace] = useState<Blockly.WorkspaceSvg>();
  // Rookie by default: same blocks, stricter limits (D17). Only paper exists until deployment (G3).
  const [experience, setExperience] = useState<Experience>('rookie');
  const validation = useLiveValidation(workspace, { experience, mode: 'paper' });

  useEffect(() => {
    if (!canvas.current) return;
    const ws = Blockly.inject(canvas.current, injectOptions);
    ensureRoot(ws);
    setWorkspace(ws);
    return () => { setWorkspace(undefined); ws.dispose(); };
  }, []);

  const onFocusBlock = useCallback((id: string) => { if (workspace) focusBlock(workspace, id); }, [workspace]);
  const onLoadPreset = useCallback((preset: Preset) => { if (workspace) loadPreset(workspace, preset); }, [workspace]);
  const onStartTutorial = useCallback(() => {
    setExperience('rookie');
    const threshold = PRESETS.find(p => p.id === 'threshold_sale');
    if (workspace && threshold) loadPreset(workspace, threshold);
  }, [workspace]);

  return (
    <main className="editor">
      <div ref={canvas} className="editor-canvas" role="region" aria-label="Strategy blocks canvas" />
      <StrategyPanel experience={experience} onExperience={setExperience} validation={validation}
        onFocusBlock={onFocusBlock} onLoadPreset={onLoadPreset} onStartTutorial={onStartTutorial}>
        <RehearsePanel workspace={workspace} program={validation?.program} />
      </StrategyPanel>
    </main>
  );
}
