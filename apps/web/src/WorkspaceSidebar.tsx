import { useState } from "react";
import type { SavedAgent } from "./api.ts";
import { Icon } from "./Icon.tsx";
export function WorkspaceSidebar({
  agents,
  currentId,
  connected,
  onNew,
  onBuild,
  onOpen,
  onReconnect,
}: {
  agents: SavedAgent[];
  currentId: string | undefined;
  connected: boolean;
  onNew: () => void;
  onBuild: () => void;
  onOpen: (agent: SavedAgent) => void;
  onReconnect: () => void;
}) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  return (
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Monad strategy studio">
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M16 3 28 10v12L16 29 4 22V10Z" />
          <path d="m4 10 12 7 12-7M16 17v12" />
        </svg>
        <span>
          monad<span className="brand-sub">STRATEGY STUDIO</span>
        </span>
      </a>
      <div className="workspace-label">
        <div>
          Personal workspace<small>Local development</small>
        </div>
      </div>
      <button className="new-strategy" onClick={() => onNew()}>
        <Icon name="plus" />
        New strategy
      </button>
      <button
        className="mobile-library-button"
        aria-expanded={libraryOpen}
        onClick={() => setLibraryOpen((open) => !open)}
      >
        Saved
      </button>
      <div className="nav-caption">WORKSPACE</div>
      <button className="nav-active" onClick={() => onBuild()}>
        <Icon name="layers" />
        Strategies<span>{agents.length}</span>
      </button>
      <div className={`library ${libraryOpen ? "mobile-open" : ""}`}>
        <div className="nav-caption">SAVED STRATEGIES</div>
        {agents.length ? (
          agents.map((agent) => (
            <button
              key={agent.id}
              className={currentId === agent.id ? "selected" : ""}
              onClick={() => {
                onOpen(agent);
                setLibraryOpen(false);
              }}
            >
              <span className="draft-dot" />
              <span>
                {agent.name}
                <small>Draft · Revision {agent.version}</small>
              </span>
            </button>
          ))
        ) : (
          <p>
            Your saved strategies
            <br />
            will live here.
          </p>
        )}
      </div>
      <div className="sidebar-bottom">
        <div className="local-status">
          <span className={`status-dot ${connected ? "" : "amber"}`} />
          {connected ? "Control API connected" : "Control API offline"}
        </div>
        {!connected && (
          <button className="link" onClick={() => onReconnect()}>
            Reconnect
          </button>
        )}
        <p>
          Mainnet observations · Paper effects
          <br />
          No real funds connected
        </p>
      </div>
    </aside>
  );
}
