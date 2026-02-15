import { Routes, Route, Navigate, NavLink, useNavigate } from "react-router-dom";
import { isAuthenticated, clearAuth } from "./api";
import { ChatProvider } from "./contexts/ChatContext";
import { ProfileProvider, useProfile } from "./contexts/ProfileContext";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Chat from "./pages/Chat";
import Approvals from "./pages/Approvals";
import Cron from "./pages/Cron";
import Workspace from "./pages/Workspace";
import Incidents from "./pages/Incidents";
import Config from "./pages/Config";
import Substrate from "./pages/Substrate";
import Heartbeat from "./pages/Heartbeat";
import Trace from "./pages/Trace";
import Memory from "./pages/Memory";
import Skills from "./pages/Skills";

function RequireAuth({ children }: { children: React.ReactNode }) {
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function ProfileSelector() {
  const { profiles, selectedProfileId, setSelectedProfileId, loading } = useProfile();
  if (loading || profiles.length === 0) return <div className="nav-profile">Profile: …</div>;
  if (profiles.length === 1) {
    return (
      <div className="nav-profile">
        <div>Profile: {profiles[0].id}</div>
        <NavLink to="/config#profiles" className="nav-profile-manage">Manage profiles</NavLink>
      </div>
    );
  }
  return (
    <div className="nav-profile">
      <label htmlFor="profile-select">Profile</label>
      <select
        id="profile-select"
        value={selectedProfileId}
        onChange={(e) => setSelectedProfileId(e.target.value)}
        className="nav-profile-select"
      >
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>{p.id}</option>
        ))}
      </select>
      <NavLink to="/config#profiles" className="nav-profile-manage">Manage profiles</NavLink>
    </div>
  );
}

function Shell() {
  const navigate = useNavigate();
  const handleLogout = () => {
    clearAuth();
    navigate("/login", { replace: true });
  };
  return (
    <div className="app">
      <ProfileProvider>
        <ChatProvider>
          <div className="app-shell">
            <nav className="nav">
              <ProfileSelector />
              <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            Dashboard
          </NavLink>
          <NavLink to="/chat" className={({ isActive }) => (isActive ? "active" : "")}>
            Chat
          </NavLink>
          <NavLink to="/approvals" className={({ isActive }) => (isActive ? "active" : "")}>
            Approvals
          </NavLink>
          <NavLink to="/cron" className={({ isActive }) => (isActive ? "active" : "")}>
            Cron
          </NavLink>
          <NavLink to="/workspace" className={({ isActive }) => (isActive ? "active" : "")}>
            Workspace
          </NavLink>
          <NavLink to="/memory" className={({ isActive }) => (isActive ? "active" : "")}>
            Memory
          </NavLink>
          <NavLink to="/incidents" className={({ isActive }) => (isActive ? "active" : "")}>
            Incidents
          </NavLink>
          <NavLink to="/config" className={({ isActive }) => (isActive ? "active" : "")}>
            Config
          </NavLink>
          <NavLink to="/skills" className={({ isActive }) => (isActive ? "active" : "")}>
            Skills
          </NavLink>
          <NavLink to="/substrate" className={({ isActive }) => (isActive ? "active" : "")}>
            Substrate
          </NavLink>
          <NavLink to="/heartbeat" className={({ isActive }) => (isActive ? "active" : "")}>
            Heartbeat
          </NavLink>
              <NavLink to="/trace" className={({ isActive }) => (isActive ? "active" : "")}>
                Trace
              </NavLink>
            </nav>
            <main className="main">
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/chat" element={<Chat />} />
                <Route path="/approvals" element={<Approvals />} />
                <Route path="/cron" element={<Cron />} />
                <Route path="/workspace" element={<Workspace />} />
                <Route path="/memory" element={<Memory />} />
                <Route path="/incidents" element={<Incidents />} />
                <Route path="/config" element={<Config />} />
                <Route path="/skills" element={<Skills />} />
                <Route path="/substrate" element={<Substrate />} />
                <Route path="/heartbeat" element={<Heartbeat />} />
                <Route path="/trace" element={<Trace />} />
              </Routes>
            </main>
          </div>
        </ChatProvider>
      </ProfileProvider>
      <footer className="footer">
        <span>CursorClaw</span>
        <button type="button" className="btn" onClick={handleLogout}>
          Logout
        </button>
      </footer>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={isAuthenticated() ? <Navigate to="/" replace /> : <Login />} />
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Shell />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
