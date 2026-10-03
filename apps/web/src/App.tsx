import { EditorPage } from './EditorPage.tsx';

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>Strategy editor</h1>
        <span className="mode-badge" aria-label="Mode: paper">Paper</span>
      </header>
      <EditorPage />
    </div>
  );
}
