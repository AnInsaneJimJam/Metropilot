import { useEffect, useRef } from 'react';
import * as Blockly from 'blockly/core';
import * as En from 'blockly/msg/en';
import { syntheticCatalog } from '@monad-hack/strategy';
import { ensureRoot, injectOptions, setUpBlockly } from './blocks/index.ts';

Blockly.setLocale(En as unknown as Record<string, string>);
setUpBlockly();

export function EditorPage() {
  const canvas = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const workspace = Blockly.inject(canvas.current, injectOptions);
    ensureRoot(workspace);
    return () => workspace.dispose();
  }, []);
  return (
    <main className="editor">
      <div ref={canvas} className="editor-canvas" role="region" aria-label="Strategy blocks canvas" />
      <aside className="editor-panel" aria-label="Strategy details">
        <h2>Paper catalog</h2>
        <ul>
          {Object.entries(syntheticCatalog.assets).map(([ref, asset]) => <li key={ref}>{ref} ({asset.decimals} decimals{asset.native ? ', native' : ''})</li>)}
        </ul>
      </aside>
    </main>
  );
}
