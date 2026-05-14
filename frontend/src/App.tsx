import { NavLink, Route, Routes, Navigate } from "react-router-dom";

import OnboardingGate from "./components/OnboardingGate";
import WebhookInbox from "./pages/WebhookInbox";
import UnrecognizedEvents from "./pages/UnrecognizedEvents";
import Flows from "./pages/Flows";
import FlowEditor from "./pages/FlowEditor";
import Connections from "./pages/Connections";
import Runs from "./pages/Runs";
import ApiCatalog from "./pages/ApiCatalog";
import Stats from "./pages/Stats";
import Templates from "./pages/Templates";
import Workbench from "./pages/Byoa";

// Header + nav adopt the a prior demo app "BYOA" glass aesthetic so the
// animated Vanta NET background renders through the chrome.
const navItem =
  "px-3 py-2 rounded-md text-sm font-medium transition-colors hover:bg-white/10";
const navActive = "bg-white/15 text-white";
const navInactive = "text-slate-300";

export default function App() {
  return (
    <OnboardingGate>
      <AppShell />
    </OnboardingGate>
  );
}

function AppShell() {
  return (
    <div className="h-full flex flex-col">
      <header className="border-b border-white/10 bg-black/40 backdrop-blur-md">
        <div className="w-full px-6 h-14 flex items-center gap-6">
          <div className="font-semibold text-white tracking-tight">
            vSplice
          </div>
          <nav className="flex items-center gap-1">
            <NavLink
              to="/inbox"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
            >
              Webhook Inbox
            </NavLink>
            <NavLink
              to="/flows"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
            >
              Flows
            </NavLink>
            <NavLink
              to="/runs"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
            >
              Runs
            </NavLink>
            <NavLink
              to="/connections"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
            >
              Connections
            </NavLink>
            <NavLink
              to="/catalog"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
            >
              API Catalog
            </NavLink>
            <NavLink
              to="/templates"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
            >
              Templates
            </NavLink>
            <NavLink
              to="/workbench"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
              title="Workbench — one-shot Gemini test runner; iterate on prompts before wiring them into a flow"
            >
              Workbench
            </NavLink>
            <NavLink
              to="/stats"
              className={({ isActive }) =>
                `${navItem} ${isActive ? navActive : navInactive}`
              }
            >
              Stats
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="flex-1 min-h-0 w-full mx-auto px-6 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/inbox" replace />} />
          <Route path="/inbox" element={<WebhookInbox />} />
          <Route path="/unrecognized" element={<UnrecognizedEvents />} />
          <Route path="/flows" element={<Flows />} />
          <Route path="/flows/new" element={<FlowEditor />} />
          <Route path="/flows/:id/edit" element={<FlowEditor />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/connections" element={<Connections />} />
          <Route path="/catalog" element={<ApiCatalog />} />
          <Route path="/templates" element={<Templates />} />
          {/* Keep /byoa as an alias so existing "Run it back" URLs work. */}
          <Route path="/workbench" element={<Workbench />} />
          <Route path="/byoa" element={<Workbench />} />
          <Route path="/stats" element={<Stats />} />
        </Routes>
      </main>
    </div>
  );
}
