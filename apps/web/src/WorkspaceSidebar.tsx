import { useState } from "react";
import type { SavedAgent } from "./api.ts";
import { BrandMark, Icon } from "./Icon.tsx";
export function WorkspaceSidebar({
  agents,
  currentId,
  connected,
  onNew,
  onOpen,
  onReconnect,
  onSignOut,
}: {
  agents: SavedAgent[];
  currentId: string | undefined;
  connected: boolean;
  onNew: () => void;
  onOpen: (agent: SavedAgent) => void;
  onReconnect: () => void;
  /** Hosted builds only (signed in with Privy). */
  onSignOut?: (() => void) | undefined;
}) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  return (
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Metropilot home">
        <BrandMark size={30} />
        <span className="brand-lockup">
          <span className="brand-word">Metropilot</span>
          <span className="brand-motto">
            Your strategy, <em>on autopilot.</em>
          </span>
        </span>
      </a>
      <button className="new-strategy" onClick={() => onNew()}>
        <Icon name="plus" size={15} />
        New strategy
      </button>
      <button
        className="mobile-library-button"
        aria-expanded={libraryOpen}
        onClick={() => setLibraryOpen((open) => !open)}
      >
        <Icon name="folder" size={15} />
        Saved
      </button>
      <div className={`library ${libraryOpen ? "mobile-open" : ""}`}>
        <div className="nav-caption">
          Saved{agents.length > 0 && <span>{agents.length}</span>}
        </div>
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
              <span>{agent.name}</span>
              <small>Draft · v{agent.version}</small>
            </button>
          ))
        ) : (
          <p>Nothing saved yet</p>
        )}
      </div>
      <div className="sidebar-bottom">
        <span className={`status-dot ${connected ? "" : "amber"}`} />
        {connected ? "Control API connected" : "Control API offline"}
        {!connected && (
          <button className="link" onClick={() => onReconnect()}>
            Reconnect
          </button>
        )}
        {onSignOut && (
          <button className="link" onClick={() => onSignOut()}>
            Sign out
          </button>
        )}
      </div>
    </aside>
  );
}
